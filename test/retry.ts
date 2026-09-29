import {test} from 'node:test';
import assert from 'node:assert/strict';
import delay from 'delay';
import timeSpan from 'time-span';
import PQueue from '../source/index.js';

const fixture = Symbol('fixture');

test('retry - succeeds after fixed-delay retries', async () => {
	const end = timeSpan();
	const queue = new PQueue();
	let attempts = 0;

	const result = await queue.add(async () => {
		attempts++;
		if (attempts < 3) {
			throw new Error('fail');
		}

		return fixture;
	}, {retries: 2, retryDelay: 50});

	assert.equal(result, fixture);
	assert.equal(attempts, 3);
	const duration = end() as number;
	assert.ok(duration >= 90, `Expected duration >= 90ms, got ${duration}ms`);
});

test('retry - rejects only after all retries are exhausted', async () => {
	const queue = new PQueue();
	let attempts = 0;
	const error = new Error('always fails');

	await assert.rejects(
		queue.add(async () => {
			attempts++;
			throw error;
		}, {retries: 2, retryDelay: 10}),
		(thrown: unknown) => thrown === error,
	);

	assert.equal(attempts, 3);
});

test('retry - no retry options keeps existing behavior', async () => {
	const queue = new PQueue();
	let attempts = 0;
	const error = new Error('fail');

	await assert.rejects(
		queue.add(async () => {
			attempts++;
			throw error;
		}),
		(thrown: unknown) => thrown === error,
	);

	assert.equal(attempts, 1);
});

test('retry - increasing delay via function receives 1-based retry number', async () => {
	const end = timeSpan();
	const queue = new PQueue();
	const seenRetryNumbers: number[] = [];
	let attempts = 0;

	const result = await queue.add(async () => {
		attempts++;
		if (attempts < 3) {
			throw new Error('fail');
		}

		return fixture;
	}, {
		retries: 2,
		retryDelay(attempt) {
			seenRetryNumbers.push(attempt);
			return attempt * 60;
		},
	});

	assert.equal(result, fixture);
	assert.deepEqual(seenRetryNumbers, [1, 2]);
	const duration = end() as number;
	// 60ms + 120ms of waiting
	assert.ok(duration >= 170, `Expected duration >= 170ms, got ${duration}ms`);
});

test('retry - releases the concurrency slot while waiting', async () => {
	const queue = new PQueue({concurrency: 1});
	const events: string[] = [];

	const first = queue.add(async () => {
		events.push('a-attempt');
		if (events.filter(event => event === 'a-attempt').length === 1) {
			throw new Error('fail once');
		}

		return 'a';
	}, {retries: 1, retryDelay: 200});

	const second = queue.add(async () => {
		events.push('b-run');
		return 'b';
	});

	assert.deepEqual(await Promise.all([first, second]), ['a', 'b']);
	// B must run while A is waiting to retry, not after A finishes.
	assert.deepEqual(events, ['a-attempt', 'b-run', 'a-attempt']);
});

test('retry - onIdle does not resolve while a retry wait is outstanding', async () => {
	const queue = new PQueue({concurrency: 1});
	let attempts = 0;

	const promise = queue.add(async () => {
		attempts++;
		if (attempts === 1) {
			throw new Error('fail once');
		}

		return fixture;
	}, {retries: 1, retryDelay: 150});

	let idleResolved = false;
	const idle = (async () => {
		await queue.onIdle();
		idleResolved = true;
	})();

	await delay(75);
	assert.equal(attempts, 1);
	assert.equal(idleResolved, false);

	assert.equal(await promise, fixture);
	await idle;
	assert.equal(idleResolved, true);
});

test('retry - abort during the wait rejects immediately', async () => {
	const end = timeSpan();
	const queue = new PQueue();
	const controller = new AbortController();
	let attempts = 0;

	const promise = queue.add(async () => {
		attempts++;
		throw new Error('fail');
	}, {retries: 5, retryDelay: 1000, signal: controller.signal});

	// Let the first attempt fail and the retry wait begin, then abort.
	await delay(50);
	controller.abort();

	await assert.rejects(promise, (thrown: unknown) => thrown === controller.signal.reason);
	assert.equal(attempts, 1);
	const duration = end() as number;
	assert.ok(duration < 500, `Expected rejection well before the 1000ms retry delay, got ${duration}ms`);
});

test('retry - abort before the wait ends prevents re-enqueueing', async () => {
	const queue = new PQueue();
	const controller = new AbortController();
	let attempts = 0;

	const promise = queue.add(async () => {
		attempts++;
		throw new Error('fail');
	}, {retries: 2, retryDelay: 50, signal: controller.signal});

	await delay(20);
	controller.abort();
	await assert.rejects(promise);

	// Wait past the original retry delays; no further attempt must run.
	await delay(150);
	assert.equal(attempts, 1);
});

test('retry - every attempt consumes an intervalCap slot', async () => {
	const queue = new PQueue({intervalCap: 1, interval: 150});
	const attemptTimes: number[] = [];
	let attempts = 0;

	const result = await queue.add(async () => {
		attempts++;
		attemptTimes.push(Date.now());
		if (attempts === 1) {
			throw new Error('fail once');
		}

		return fixture;
	}, {retries: 1, retryDelay: 0});

	assert.equal(result, fixture);
	assert.equal(attempts, 2);
	const gap = attemptTimes[1]! - attemptTimes[0]!;
	assert.ok(gap >= 100, `Expected the retry to wait for the next interval window, got a ${gap}ms gap`);
});

test('retry - clear() cancels the wait and leaves no timer behind', async () => {
	const queue = new PQueue();
	let attempts = 0;

	const promise = queue.add(async () => {
		attempts++;
		throw new Error('fail');
	}, {retries: 3, retryDelay: 50});

	// Note: clear() leaves the promise unsettled, so it is never awaited.
	await delay(20);
	assert.equal(attempts, 1);
	queue.clear();

	// Wait well past the retry delay; no further attempt must run.
	await delay(200);
	assert.equal(attempts, 1);
	assert.equal(queue.pending, 0);
	assert.equal(queue.size, 0);

	// The queue is idle again and usable.
	assert.equal(await queue.add(async () => fixture), fixture);
});

test('retry - pause() keeps the wait running but does not start the retry', async () => {
	const queue = new PQueue();
	let attempts = 0;

	const promise = queue.add(async () => {
		attempts++;
		if (attempts === 1) {
			throw new Error('fail once');
		}

		return fixture;
	}, {retries: 1, retryDelay: 50});

	await delay(20);
	queue.pause();

	// The retry wait elapses while paused, but the attempt must not start.
	await delay(100);
	assert.equal(attempts, 1);
	assert.equal(queue.size, 1);

	queue.start();
	assert.equal(await promise, fixture);
	assert.equal(attempts, 2);
});

test('retry - invalid options are rejected', async () => {
	const queue = new PQueue();
	const task = async () => fixture;

	await assert.rejects(queue.add(task, {retries: -1}), TypeError);
	await assert.rejects(queue.add(task, {retries: 1.5}), TypeError);
	await assert.rejects(queue.add(task, {retryDelay: -1}), TypeError);
	await assert.rejects(queue.add(task, {retryDelay: Number.NaN}), TypeError);
});
