import type { AgentBeneficiary, AgentCustomer, AgentTransaction } from '@pay2all/database';
import { maskAccount, money } from './agent-common';

export function presentCustomer(c: AgentCustomer, extra?: { transactions?: number; last_transaction_at?: Date | null }) {
  return {
    id: c.id,
    name: c.name,
    mobile: c.mobile,
    email: c.email,
    address_line: c.addressLine,
    city: c.city,
    pincode: c.pincode,
    date_of_birth: c.dateOfBirth ? c.dateOfBirth.toISOString().slice(0, 10) : null,
    id_type: c.idType,
    id_number_masked: c.idNumberLast4 ? `XXXX${c.idNumberLast4}` : null,
    note: c.note,
    created_at: c.createdAt,
    ...(extra ?? {}),
  };
}

/** `accountNumber`: the decrypted number, only when the caller is allowed to see it in full. */
export function presentBeneficiary(b: AgentBeneficiary, accountNumber?: string | null) {
  return {
    id: b.id,
    customer_id: b.customerId,
    name: b.name,
    bank_name: b.bankName,
    account_number: accountNumber ?? null,
    account_masked: maskAccount(b.accountLast4),
    ifsc: b.ifsc,
    upi_id: b.upiId,
    relation: b.relation,
    active: b.active,
    created_at: b.createdAt,
  };
}

export function presentTransaction(t: AgentTransaction) {
  return {
    id: t.id,
    receipt_no: t.receiptNo,
    type: t.type,
    direction: t.direction,
    mode: t.mode,
    status: t.status,
    amount: money(t.amountMinor),
    fee: money(t.feeMinor),
    /** What the customer paid (IN) or received (OUT) in total. */
    total: money(t.direction === 'IN' ? t.amountMinor + t.feeMinor : t.amountMinor - t.feeMinor),
    reference: t.reference,
    description: t.description,
    customer: t.customerName || t.customerMobile ? { id: t.customerId, name: t.customerName, mobile: t.customerMobile } : null,
    beneficiary: t.beneficiaryName
      ? { id: t.beneficiaryId, name: t.beneficiaryName, bank_name: t.beneficiaryBank, account_masked: t.beneficiaryAccount, ifsc: t.beneficiaryIfsc, upi_id: t.beneficiaryUpi }
      : null,
    occurred_at: t.occurredAt,
    created_by: t.createdByName,
    status_note: t.statusNote,
    status_changed_at: t.statusChangedAt,
    receipt_sent_at: t.receiptSentAt,
    receipt_token: t.receiptToken,
    created_at: t.createdAt,
  };
}
