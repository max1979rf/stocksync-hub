import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchAllPages } from "./fetchAllPages.ts";

test("carrega parcelas além de 1000 mesmo com limite da API menor que a página", async () => {
  const source = Array.from({ length: 1790 }, (_, id) => ({ id, amount: 50 }));
  const result = await fetchAllPages(async (from, to) => ({
    data: source.slice(from, Math.min(to + 1, from + 200)),
    error: null,
  }));
  assert.deepEqual(result, source);
  assert.equal(new Set(result.map((row) => row.id)).size, source.length);
});

test("não retorna saldo parcial quando uma página falha", async () => {
  const failure = new Error("Falha ao carregar");
  await assert.rejects(
    fetchAllPages(async (from) =>
      from === 0 ? { data: [{ id: 1 }], error: null } : { data: null, error: failure },
    ),
    failure,
  );
});

test("aceita consulta vazia", async () => {
  assert.deepEqual(await fetchAllPages(async () => ({ data: [], error: null })), []);
});
