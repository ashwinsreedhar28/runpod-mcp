// Runtime and GraphQL requests share the SDK's deadline implementation.
// It covers headers and body consumption, preserves caller cancellation, and
// stops waiting even if an injected fetch or stream ignores the abort signal.
export { createDeadlineFetch as boundedFetch } from '@runpod/typescript-api-sdk';
