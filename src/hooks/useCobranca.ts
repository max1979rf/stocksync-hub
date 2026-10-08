import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useProfile } from "@/hooks/useProfile";
import { fetchAllPages } from "@/lib/fetchAllPages";
import {
  diasEmAtraso,
  round2,
  situacaoParcela,
  worseSituacao,
  type SituacaoParcela,
} from "@/lib/cobranca";

export interface CobrancaInstallmentRow {
  id: string;
  order_id: string;
  installment_number: number;
  due_date: string;
  amount: number;
  amount_paid: number;
  payment_date: string | null;
  payment_method: string | null;
  status: string;
  orders: {
    id: string;
    order_number: string;
    order_type: string;
    total_amount: number;
    installments: number;
    status: string;
    created_at: string;
    customer_id: string;
    organization_id: string;
    customers: {
      id: string;
      name: string;
      cpf_cnpj: string | null;
      phone: string | null;
      whatsapp: string | null;
      is_deleted?: boolean;
      customer_addresses: {
        city: string | null;
        neighborhood: string | null;
        street: string | null;
        number: string | null;
        complement: string | null;
      }[];
    };
    order_items: { quantity: number; products: { name: string } | null }[];
  };
}

// Reaproveita exatamente o truque de escopo por organização já comprovado em
// clientes.tsx:161-174 (installments não tem organization_id própria — o
// escopo é feito via orders!inner).
export function useCobrancaInstallments() {
  const { data: profile } = useProfile();
  const orgId = profile?.active_org_id;

  return useQuery({
    queryKey: ["cobranca_installments", orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const data = await fetchAllPages((from, to) =>
        supabase
          .from("installments")
          .select(
            `*, orders!inner(
            id, order_number, order_type, total_amount, installments, status, created_at, customer_id, organization_id,
            customers(id, name, cpf_cnpj, phone, whatsapp, is_deleted, customer_addresses(city, neighborhood, street, number, complement)),
            order_items(quantity, products(name))
          )`,
          )
          .eq("orders.organization_id", orgId!)
          .neq("orders.status", "Cancelado")
          .order("due_date")
          .order("id")
          .range(from, to),
      );
      // Se a coluna amount_paid não vem no payload, o cache de schema do
      // PostgREST ainda não foi recarregado depois da migration — avisa
      // explicitamente em vez de deixar a UI esconder a baixa silenciosamente.
      if (data && data.length > 0 && !("amount_paid" in data[0])) {
        throw new Error(
          "A coluna amount_paid não está visível para a API ainda. Rode NOTIFY pgrst, 'reload schema'; no SQL Editor do Supabase (ou Project Settings → API → Reload schema cache) e recarregue a página.",
        );
      }
      // Normaliza amount/amount_paid para número — protege contra numeric
      // vindo como string/null.
      return ((data ?? []) as unknown as CobrancaInstallmentRow[]).map((row) => ({
        ...row,
        amount: Number(row.amount ?? 0),
        amount_paid: Number(row.amount_paid ?? 0),
      }));
    },
  });
}

export interface CobrancaOrderGroup {
  order_id: string;
  order_number: string;
  created_at: string;
  total_amount: number;
  installments_count: number;
  paid_count: number;
  total_paid: number;
  total_saldo: number;
  next_due_date: string | null;
  max_dias_atraso: number;
  situacao: SituacaoParcela;
  customer: CobrancaInstallmentRow["orders"]["customers"];
  installments: CobrancaInstallmentRow[];
}

// Agrupa as parcelas por venda: 1 linha por venda na tabela, em vez de 1
// linha por parcela — evita repetir cliente/telefone/etc. N vezes quando uma
// venda tem N parcelas.
export function groupInstallmentsByOrder(rows: CobrancaInstallmentRow[]): CobrancaOrderGroup[] {
  const groups = new Map<string, CobrancaOrderGroup>();

  for (const row of rows) {
    const saldo = round2(row.amount - row.amount_paid);
    const situacao = situacaoParcela({
      amount: row.amount,
      amountPaid: row.amount_paid,
      dueDate: row.due_date,
    });
    const dias = diasEmAtraso(row.due_date, saldo);

    let group = groups.get(row.order_id);
    if (!group) {
      group = {
        order_id: row.order_id,
        order_number: row.orders.order_number,
        created_at: row.orders.created_at,
        total_amount: row.orders.total_amount,
        installments_count: row.orders.installments,
        paid_count: 0,
        total_paid: 0,
        total_saldo: 0,
        next_due_date: null,
        max_dias_atraso: 0,
        situacao: "quitada",
        customer: row.orders.customers,
        installments: [],
      };
      groups.set(row.order_id, group);
    }

    group.installments.push(row);
    if (row.status === "Pago") group.paid_count++;
    group.total_paid += Number(row.amount_paid || 0);
    group.total_saldo += saldo;
    group.max_dias_atraso = Math.max(group.max_dias_atraso, dias);
    group.situacao = worseSituacao(group.situacao, situacao);
    if (saldo > 0 && (!group.next_due_date || row.due_date < group.next_due_date)) {
      group.next_due_date = row.due_date;
    }
  }

  for (const group of groups.values()) {
    group.total_paid = round2(group.total_paid);
    group.total_saldo = round2(group.total_saldo);
    group.installments.sort((a, b) => a.installment_number - b.installment_number);
  }

  return Array.from(groups.values());
}

// KPIs "recebido hoje" / "recebido no mês" não podem vir da própria parcela
// (installments.payment_date só guarda a data do ÚLTIMO pagamento) — vêm do
// histórico real em installment_payments.
export function useCobrancaRecebimentosPeriodo() {
  const { data: profile } = useProfile();
  const orgId = profile?.active_org_id;

  return useQuery({
    queryKey: ["cobranca_recebimentos_periodo", orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

      const data = await fetchAllPages((from, to) =>
        supabase
          .from("installment_payments")
          .select("amount, created_at")
          .eq("organization_id", orgId!)
          .eq("status", "ativo")
          .gte("created_at", startOfMonth)
          .order("created_at")
          .order("id")
          .range(from, to),
      );

      const rows = data ?? [];
      const recebidoHoje = rows
        .filter((r) => r.created_at >= startOfToday)
        .reduce((sum, r) => sum + Number(r.amount), 0);
      const recebidoNoMes = rows.reduce((sum, r) => sum + Number(r.amount), 0);
      return { recebidoHoje, recebidoNoMes };
    },
  });
}

export function useInstallmentPaymentHistory(installmentId: string | null) {
  const { data: profile } = useProfile();
  const orgId = profile?.active_org_id;

  return useQuery({
    queryKey: ["installment_payment_history", installmentId],
    enabled: !!installmentId && !!orgId,
    queryFn: async () => {
      const [{ data: payments, error }, { data: orgProfilesRaw }] = await Promise.all([
        supabase
          .from("installment_payments")
          .select("*")
          .eq("installment_id", installmentId!)
          .order("created_at", { ascending: false }),
        supabase.rpc("get_org_member_profiles" as never, { p_org_id: orgId! } as never),
      ]);
      if (error) throw error;

      const orgProfiles = (orgProfilesRaw ?? []) as unknown as {
        id: string;
        full_name: string | null;
      }[];
      const profileById = new Map(orgProfiles.map((p) => [p.id, p.full_name]));

      return (payments ?? []).map((p) => ({
        ...p,
        created_by_name: profileById.get(p.created_by) ?? "—",
        cancelled_by_name: p.cancelled_by ? (profileById.get(p.cancelled_by) ?? "—") : null,
      }));
    },
  });
}

interface ReceivePaymentInput {
  installmentId: string;
  paymentMethod: string;
  amount?: number | null;
  notes?: string | null;
  clientRequestId: string;
}

export function useReceiveInstallmentPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ReceivePaymentInput) => {
      const { data, error } = await supabase.rpc(
        "fn_receive_installment_payment" as never,
        {
          p_installment_id: input.installmentId,
          p_payment_method: input.paymentMethod,
          p_amount: input.amount ?? null,
          p_notes: input.notes ?? null,
          p_client_request_id: input.clientRequestId,
        } as never,
      );
      if (error) throw error;
      return data;
    },
    onSuccess: (_data, input) => {
      qc.invalidateQueries({ queryKey: ["cobranca_installments"] });
      qc.invalidateQueries({ queryKey: ["cobranca_recebimentos_periodo"] });
      qc.invalidateQueries({ queryKey: ["installment_payment_history", input.installmentId] });
      qc.invalidateQueries({ queryKey: ["installments"] });
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["financial_transactions"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}

interface CancelPaymentInput {
  paymentId: string;
  installmentId: string;
  reason?: string | null;
}

export function useCancelInstallmentPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CancelPaymentInput) => {
      const { data, error } = await supabase.rpc(
        "fn_cancel_installment_payment" as never,
        {
          p_payment_id: input.paymentId,
          p_reason: input.reason ?? null,
        } as never,
      );
      if (error) throw error;
      return data;
    },
    onSuccess: (_data, input) => {
      qc.invalidateQueries({ queryKey: ["cobranca_installments"] });
      qc.invalidateQueries({ queryKey: ["cobranca_recebimentos_periodo"] });
      qc.invalidateQueries({ queryKey: ["installment_payment_history", input.installmentId] });
      qc.invalidateQueries({ queryKey: ["installments"] });
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["financial_transactions"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}

export function useLogCollectionAttempt() {
  const { data: profile } = useProfile();
  const orgId = profile?.active_org_id;

  return useMutation({
    mutationFn: async (input: {
      installmentId: string;
      channel: string;
      notes?: string | null;
    }) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const { error } = await supabase.from("audit_logs").insert({
        organization_id: orgId!,
        table_name: "installments",
        record_id: input.installmentId,
        action: "tentativa_cobranca",
        old_data: null,
        new_data: { channel: input.channel, notes: input.notes ?? null },
        performed_by: user?.id ?? null,
      });
      if (error) throw error;
    },
  });
}
