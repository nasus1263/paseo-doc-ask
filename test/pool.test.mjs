import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentPool } from "../server/pool.ts";

/** A pool whose agents are named a1, a2, …; records what it discarded. */
function makePool(max, existing = []) {
  let created = 0;
  const discarded = [];
  const pool = new AgentPool(
    max,
    async () => `a${++created}`,
    async (id) => {
      discarded.push(id);
    },
    Promise.resolve(existing),
  );
  return { pool, discarded, created: () => created };
}

test("requests made together each get their own agent", async () => {
  const { pool, created } = makePool(4);
  const ids = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
  assert.equal(new Set(ids).size, 3);
  assert.equal(created(), 3);
});

test("a returned agent is reused before a new one is created", async () => {
  const { pool, created } = makePool(4);
  const first = await pool.acquire();
  await pool.release(first, true);
  assert.equal(await pool.acquire(), first);
  assert.equal(created(), 1);
});

test("agents left from an earlier run are reused", async () => {
  const { pool, created } = makePool(4, ["old"]);
  assert.equal(await pool.acquire(), "old");
  assert.equal(created(), 0);
});

test("past the limit a request waits for an agent to come back", async () => {
  const { pool, created } = makePool(2);
  const [a, b] = await Promise.all([pool.acquire(), pool.acquire()]);
  let third = null;
  const waiting = pool.acquire().then((id) => (third = id));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(third, null);
  await pool.release(a, true);
  await waiting;
  assert.equal(third, a);
  assert.equal(created(), 2);
  void b;
});

test("a discarded agent frees its slot for a waiting request", async () => {
  const { pool, discarded, created } = makePool(1);
  const a = await pool.acquire();
  const waiting = pool.acquire();
  await pool.release(a, false);
  assert.equal(await waiting, "a2");
  assert.deepEqual(discarded, [a]);
  assert.equal(created(), 2);
});

test("retireAll discards idle agents now and borrowed ones when they come back", async () => {
  const { pool, discarded } = makePool(4);
  const [a, b] = await Promise.all([pool.acquire(), pool.acquire()]);
  await pool.release(a, true);
  assert.equal(await pool.retireAll(), 2);
  assert.deepEqual(discarded, [a]);
  await pool.release(b, true);
  assert.deepEqual(discarded, [a, b]);
  assert.equal(await pool.acquire(), "a3");
});

test("a failed creation frees its slot", async () => {
  let fail = true;
  const pool = new AgentPool(
    1,
    async () => {
      if (fail) throw new Error("boom");
      return "ok";
    },
    async () => {},
    Promise.resolve([]),
  );
  await assert.rejects(pool.acquire(), /boom/);
  fail = false;
  assert.equal(await pool.acquire(), "ok");
});
