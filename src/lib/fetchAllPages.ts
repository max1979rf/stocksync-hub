// Continue até uma página vazia: a API pode impor um limite menor que o solicitado.
// A consulta deve ordenar por uma chave única para estabilizar a paginação.
export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  pageSize = 500,
): Promise<T[]> {
  const rows: T[] = [];
  while (true) {
    const { data, error } = await fetchPage(rows.length, rows.length + pageSize - 1);
    if (error) throw error;
    if (!data?.length) return rows;
    rows.push(...data);
  }
}
