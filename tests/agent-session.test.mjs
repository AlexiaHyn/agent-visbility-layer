import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SingleAgentSession } from '../agent-session.mjs';

const setup = () => new SingleAgentSession({ workspace: '/unused/project', sessionDir: '/unused/sessions' });

test('cancellation aborts the session and prevents another prompt', async () => {
  const agent = setup();
  let aborted = 0;
  let prompted = 0;
  agent.session = { abort: async () => { aborted++; }, prompt: async () => { prompted++; } };
  await agent.cancel();
  assert.equal(aborted, 1);
  await agent.prompt('Do not send this');
  assert.equal(prompted, 0);
});

test('disposal releases subscriptions and the session exactly once', () => {
  const agent = setup();
  let unsubscribed = 0;
  let disposed = 0;
  agent.session = {
    subscribe: () => () => { unsubscribed++; },
    dispose: () => { disposed++; },
  };
  agent.subscribe(() => {});
  agent.dispose();
  agent.dispose();
  assert.equal(unsubscribed, 1);
  assert.equal(disposed, 1);
});
