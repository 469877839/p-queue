import {expectType} from 'tsd';
import PQueue from '../source/index.js';

const queue = new PQueue();

expectType<Promise<string>>(queue.add(async () => '🦄'));

// Retry options
expectType<Promise<string>>(queue.add(async () => '🦄', {retries: 2, retryDelay: 100}));
expectType<Promise<string>>(queue.add(async () => '🦄', {retries: 3, retryDelay: attempt => attempt * 100}));
expectType<Promise<string[]>>(queue.addAll([async () => '🦄'], {retries: 1, retryDelay: 0}));
