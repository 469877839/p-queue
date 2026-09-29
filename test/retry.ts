import {test} from 'node:test';
import assert from 'node:assert/strict';
import delay from 'delay';
import timeSpan from 'time-span';
import PQueue from '../source/index.js';

test('retry - succeeds after fixed-delay retries', async () => {
	const queue = new PQueue();
	let attempts = 0;
	const end = timeSpan();
	const result = await queue.add(async () => {
		attempts++;
		if (attempts < 3) {
			throw new Error(`fail ${attempts}`);
		}

		return 'ok';
	}, {retries: 2, retryDelay: 100});

	assert.equal(result, 'ok');
	assert.equal(attempts, 3);
	const duration = end() as number;
	assert.ok(duration >= 190, `Expected at least ~200ms of retry delay, got ${duration}ms`);
});

test('retry - rejects only after all attempts fail', async () => {
	const queue = new PQueue();
	let attempts = 0;
	await assert.rejects(
		queue.add(async () => {
			attempts++;
			throw new Error(`fail ${attempts}`);
		}, {retries: 2, retryDelay: 10}),
		/fail 3/,
	);
	assert.equal(attempts, 3);
});

test('retry - increasing delay via function', async () => {
	const queue = new PQueue();
	const attemptTimes: number[] = [];
	let attempts = 0;
	await assert.rejects(queue.add(async () => {
		attempts++;
		attemptTimes.push(Date.now());
		throw new Error(`fail ${attempts}`);
	}, {retries: 2, retryDelay: attempt => attempt * 100}));

	assert.equal(attempts, 3);
	const firstGap = attemptTimes[1]! - attemptTimes[0]!;
	const secondGap = attemptTimes[2]! - attemptTimes[1]!;
	assert.ok(firstGap >= 90, `Expected first gap to be ~100ms, got ${firstGap}ms`);
	assert.ok(secondGap >= 190, `Expected second gap to be ~200ms, got ${secondGap}ms`);
	assert.ok(secondGap > firstGap, 'Expected the delay to increase per attempt');
});

test('retry - releases the concurrency slot while waiting', async () => {
	const queue = new PQueue({concurrency: 1});
	let attempts = 0;
	const slow = queue.add(async () => {
		attempts++;
		if (attempts === 1) {
			throw new Error('fail');
		}

		return 'slow';
	}, {retries: 1, retryDelay: 200});
	const fast = queue.add(async () => 'fast');

	// The queued task runs while the failed one waits out its retry delay.
	assert.equal(await fast, 'fast');
	assert.equal(attempts, 1);
	assert.equal(await slow, 'slow');
	assert.equal(attempts, 2);
});

test('retry - onIdle does not resolve while waiting to retry', async () => {
	const queue = new PQueue({concurrency: 1});
	let attempts = 0;
	const promise = queue.add(async () => {
		attempts++;
		if (attempts === 1) {
			throw new Error('fail');
		}

		return 'ok';
	}, {retries: 1, retryDelay: 150});

	let idle = false;
	const idlePromise = (async () => {
		await queue.onIdle();
		idle = true;
	})();

	await delay(50);
	assert.equal(queue.pending, 0); // The concurrency slot was released.
	assert.equal(idle, false); // But the retry is still unfinished work.

	assert.equal(await promise, 'ok');
	await idlePromise;
	assert.equal(idle, true);
});

test('retry - abort during the retry wait rejects immediately', async () => {
	const queue = new PQueue();
	const controller = new AbortController();
	let attempts = 0;
	const end = timeSpan();
	const promise = queue.add(async () => {
		attempts++;
		throw new Error(`fail ${attempts}`);
	}, {retries: 5, retryDelay: 1000, signal: controller.signal});

	setTimeout(() => {
		controller.abort();
	}, 50);

	await assert.rejects(promise);
	const duration = end() as number;
	assert.ok(duration < 500, `Expected abort to reject promptly, took ${duration}ms`);
	assert.equal(attempts, 1);

	// The retry timer must not fire after the task was cancelled.
	await delay(1100);
	assert.equal(attempts, 1);
});

test('retry - every attempt consumes an intervalCap slot', async () => {
	const queue = new PQueue({intervalCap: 2, interval: 250});
	let attempts = 0;
	const end = timeSpan();
	await assert.rejects(queue.add(async () => {
		attempts++;
		throw new Error(`fail ${attempts}`);
	}, {retries: 2, retryDelay: 10}));

	assert.equal(attempts, 3);
	const duration = end() as number;
	// The first two attempts fit the window; the third had to wait for the next one.
	assert.ok(duration >= 200, `Expected the third attempt to wait for a new window, took ${duration}ms`);
});

test('retry - clear() cancels a pending retry and rejects with the last error', async () => {
	const queue = new PQueue();
	let attempts = 0;
	const promise = queue.add(async () => {
		attempts++;
		throw new Error('boom');
	}, {retries: 5, retryDelay: 1000});

	await delay(20);
	queue.clear();
	await assert.rejects(promise, /boom/);

	// The retry timer must not fire after clear().
	await delay(1100);
	assert.equal(attempts, 1);
});

test('retry - no retries by default', async () => {
	const queue = new PQueue();
	let attempts = 0;
	await assert.rejects(queue.add(async () => {
		attempts++;
		throw new Error('fail');
	}));
	assert.equal(attempts, 1);
});
