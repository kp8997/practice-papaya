# Claims Workflow Orchestrator — CLI Manual Verification Guide

This guide provides an exhaustive suite of runnable CLI commands to manually test and verify **every state transition, precondition gate, role authorization rule (RBAC), cycle loop limit, clock-based appeal expiration, and extensibility path** in the system.

---

## 1. Quick Setup & Launch

Open a terminal in the project root:

```bash
cd "02 AI Challenges/AI Challenge 14 - Claims Workflow Orchestrator"
```

### Launch Interactive CLI Prompt

```bash
# Launch with Base Workflow (v1.0.0 — 8 states, 5 roles)
npm start

# OR launch with Fraud Check Extended Workflow (v1.1.0 — 9 states, 6 roles)
npm start -- --config config/claims-workflow.fraud-check.yaml
```

Once launched, you will see the interactive prompt:
```text
claims> 
```
*(All commands below are typed directly into the `claims> ` prompt without the prefix `claims`).*

---

## 2. Test Suite 1: Full Happy Path to Terminal `CLOSED`

**Objective**: Verify the complete standard claim lifecycle: `SUBMITTED` $\rightarrow$ `DOCUMENTS_VERIFIED` $\rightarrow$ `UNDER_ASSESSMENT` $\rightarrow$ `APPROVED` $\rightarrow$ `PAYMENT_INITIATED` $\rightarrow$ `CLOSED`.

```bash
# 1. Create a claim with valid amount, policy limit, and required documents
create -i CLM-HAPPY --amount 4500 --limit 10000 --docs claim_form,medical_report,itemized_receipt --notes "Initial submission for minor surgery"

# 2. Inspect available transitions from SUBMITTED (shows DOCUMENTS_VERIFIED with role document_clerk)
show CLM-HAPPY

# 3. Transition: SUBMITTED -> DOCUMENTS_VERIFIED (Role: document_clerk)
advance CLM-HAPPY DOCUMENTS_VERIFIED -r document_clerk -u clerk-bob --notes "All documents checked"

# 4. Transition: DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT (Role: team_lead, assigns assessor-alice)
advance CLM-HAPPY UNDER_ASSESSMENT -r team_lead -u lead-sarah -s assessorId=assessor-alice

# 5. Transition: UNDER_ASSESSMENT -> APPROVED (Role: assessor, completes report)
advance CLM-HAPPY APPROVED -r assessor -u assessor-alice -s assessmentReportComplete=true --notes "Treatment covered under policy schedule A"

# 6. Transition: APPROVED -> PAYMENT_INITIATED (Role: finance, generates PR-CLM-HAPPY-xxxx)
advance CLM-HAPPY PAYMENT_INITIATED -r finance -u finance-frank --notes "Payment request created for treasury batch"

# 7. Transition: PAYMENT_INITIATED -> CLOSED (Role: finance, records payout confirmation)
advance CLM-HAPPY CLOSED -r finance -u finance-frank -s paymentConfirmed=true -s paymentReference=EFT-2026-0001 --notes "EFT payment confirmed by bank"

# 8. Verify the immutable audit trail and event-sourcing replay
audit CLM-HAPPY

# 9. Verify the transactional outbox dispatched side-effects
outbox CLM-HAPPY
```

---

## 3. Test Suite 2: Document Verification Preconditions & Resubmission

**Objective**: Verify that document verification fails if required documents are missing, and succeeds once provided.

```bash
# 1. Create claim with MISSING required documents (only claim_form provided)
create -i CLM-DOCS --amount 3000 --limit 10000 --docs claim_form

# 2. Negative Test: Try to verify documents (Expect: PRECONDITION_FAILED)
advance CLM-DOCS DOCUMENTS_VERIFIED -r document_clerk -u clerk-bob
# Output: [DENIED] Precondition check failed: Required documents present and valid (effective.submittedDocuments includes_all effective.requiredDocuments)

# 3. Inspect audit trail to confirm DENIED attempt is recorded immutably
audit CLM-DOCS

# 4. Success Test: Document clerk supplies missing documents during verification
advance CLM-DOCS DOCUMENTS_VERIFIED -r document_clerk -u clerk-bob -s submittedDocuments=claim_form,medical_report,itemized_receipt --notes "Member brought physical receipts"
# Output: [OK] SUBMITTED -> DOCUMENTS_VERIFIED (v2)
```

---

## 4. Test Suite 3: Role-Based Access Control (RBAC) & Assessor Identity

**Objective**: Verify that only authorized roles can trigger transitions, and that only the assigned assessor can approve/reject.

```bash
# 1. Create a claim
create -i CLM-RBAC --amount 2500 --limit 10000 --docs claim_form,medical_report,itemized_receipt

# 2. Negative Test: Unauthorized role tries to verify documents (Role: finance)
advance CLM-RBAC DOCUMENTS_VERIFIED -r finance -u finance-frank
# Output: [DENIED] Role 'finance' is not authorized. Required role(s): document_clerk

# 3. Advance to DOCUMENTS_VERIFIED correctly
advance CLM-RBAC DOCUMENTS_VERIFIED -r document_clerk -u clerk-bob

# 4. Advance to UNDER_ASSESSMENT and assign to 'assessor-alice'
advance CLM-RBAC UNDER_ASSESSMENT -r team_lead -u lead-sarah -s assessorId=assessor-alice

# 5. Negative Test: A different assessor (assessor-dave) tries to approve
advance CLM-RBAC APPROVED -r assessor -u assessor-dave -s assessmentReportComplete=true
# Output: [DENIED] Assessor 'assessor-dave' is not authorized: claim is assigned to assessor 'assessor-alice'

# 6. Success Test: Assigned assessor (assessor-alice) approves
advance CLM-RBAC APPROVED -r assessor -u assessor-alice -s assessmentReportComplete=true
# Output: [OK] UNDER_ASSESSMENT -> APPROVED (v3)
```

---

## 5. Test Suite 4: Preconditions at Assessment (Amount > Limit & Report Status)

**Objective**: Verify that approval is blocked if amount exceeds policy limit or assessment report is incomplete.

```bash
# 1. Create high-amount claim: amount ($15,000) > policy limit ($10,000)
create -i CLM-LIMIT --amount 15000 --limit 10000 --docs claim_form,medical_report,itemized_receipt

# 2. Advance to UNDER_ASSESSMENT
advance CLM-LIMIT DOCUMENTS_VERIFIED -r document_clerk -u clerk-bob
advance CLM-LIMIT UNDER_ASSESSMENT -r team_lead -u lead-sarah -s assessorId=assessor-alice

# 3. Negative Test A: Try to approve when amount exceeds limit ($15,000 > $10,000)
advance CLM-LIMIT APPROVED -r assessor -u assessor-alice -s assessmentReportComplete=true
# Output: [DENIED] Precondition check failed: Claim amount does not exceed policy limit (effective.amount <= effective.policyLimit)

# 4. Negative Test B: Try to approve without completing assessment report
advance CLM-LIMIT APPROVED -r assessor -u assessor-alice -s amount=8000 -s assessmentReportComplete=false
# Output: [DENIED] Precondition check failed: Assessment report marked complete (effective.assessmentReportComplete == true)

# 5. Success Test: Valid amount ($8,000 <= $10,000) and completed report
advance CLM-LIMIT APPROVED -r assessor -u assessor-alice -s amount=8000 -s assessmentReportComplete=true
# Output: [OK] UNDER_ASSESSMENT -> APPROVED (v3)
```

---

## 6. Test Suite 5: Rejection Path & 30-Day Appeal Expiration Clock Check

**Objective**: Verify rejection reason requirement, premature closure block (< 30 days without acknowledgement), member acknowledgement closure, and automatic closure after 30-day appeal window expires.

```bash
# 1. Create and advance claim to UNDER_ASSESSMENT
create -i CLM-APPEAL --amount 5000 --limit 10000 --docs claim_form,medical_report,itemized_receipt
advance CLM-APPEAL DOCUMENTS_VERIFIED -r document_clerk -u clerk-bob
advance CLM-APPEAL UNDER_ASSESSMENT -r team_lead -u lead-sarah -s assessorId=assessor-alice

# 2. Negative Test: Try to reject without rejection reason
advance CLM-APPEAL REJECTED -r assessor -u assessor-alice -s assessmentReportComplete=true
# Output: [REJECTED — PRECONDITION_FAILED] Rejection reason provided: effective.rejectionReason must not be empty

# 3. Success Test: Reject with completed report and valid reason
advance CLM-APPEAL REJECTED -r assessor -u assessor-alice -s assessmentReportComplete=true -s rejectionReason="Pre-existing condition excluded under Clause 3"
# Output: [OK] UNDER_ASSESSMENT -> REJECTED (v4)

# 4. Inspect claim status & simulated clock
show CLM-APPEAL
clock

# 5. Negative Test: Try to close immediately before 30-day appeal window expires (without memberAcknowledged)
advance CLM-APPEAL CLOSED -r system
# Output: [REJECTED — PRECONDITION_FAILED] Appeal period expired OR member acknowledged

# 6. Advance simulated clock past 30 days (+31 days)
clock +31

# 7. Final Closure: System closes after 30-day appeal window expires
advance CLM-APPEAL CLOSED -r system --notes "Appeal period elapsed with no valid appeal filed"
# Output: [OK] REJECTED -> CLOSED (v5)
```

---

## 7. Test Suite 6: Request Info Loop & Cycle Limit (Max 3 Loops)

**Objective**: Verify the ping-pong loop (`UNDER_ASSESSMENT` $\leftrightarrow$ `PENDING_INFO` $\leftrightarrow$ `DOCUMENTS_VERIFIED`), document accumulation, loop iteration limits (max 3), and post-limit approval.

```bash
# 1. Create claim and advance to UNDER_ASSESSMENT
create -i CLM-LOOP --amount 4000 --limit 10000 --docs claim_form,medical_report,itemized_receipt
advance CLM-LOOP DOCUMENTS_VERIFIED -r document_clerk -u clerk-bob
advance CLM-LOOP UNDER_ASSESSMENT -r team_lead -u lead-sarah -s assessorId=assessor-alice

# === LOOP 1 ===
advance CLM-LOOP PENDING_INFO -r assessor -u assessor-alice -s missingInfoDescription="Need surgical breakdown"
advance CLM-LOOP DOCUMENTS_VERIFIED -r document_clerk -u clerk-bob -s newDocuments=surgical_breakdown
advance CLM-LOOP UNDER_ASSESSMENT -r team_lead -u lead-sarah -s assessorId=assessor-alice

# === LOOP 2 ===
advance CLM-LOOP PENDING_INFO -r assessor -u assessor-alice -s missingInfoDescription="Need anesthesia invoice"
advance CLM-LOOP DOCUMENTS_VERIFIED -r document_clerk -u clerk-bob -s newDocuments=anesthesia_invoice
advance CLM-LOOP UNDER_ASSESSMENT -r team_lead -u lead-sarah -s assessorId=assessor-alice

# === LOOP 3 ===
advance CLM-LOOP PENDING_INFO -r assessor -u assessor-alice -s missingInfoDescription="Need pharmacy itemized receipt"
advance CLM-LOOP DOCUMENTS_VERIFIED -r document_clerk -u clerk-bob -s newDocuments=pharmacy_receipt
advance CLM-LOOP UNDER_ASSESSMENT -r team_lead -u lead-sarah -s assessorId=assessor-alice

# === ATTEMPT 4 (Exceeds Max 3 Cycles) ===
# Negative Test: 4th attempt to request info must be blocked by cycle detector
advance CLM-LOOP PENDING_INFO -r assessor -u assessor-alice -s missingInfoDescription="4th info request"
# Output: [REJECTED — CYCLE_LIMIT_EXCEEDED] Maximum information requests exceeded — escalate to team lead

# === Post-Limit Recovery ===
# The claim is NOT stuck: Assessor can now approve with the documents gathered so far
advance CLM-LOOP APPROVED -r assessor -u assessor-alice -s assessmentReportComplete=true
# Output: [OK] UNDER_ASSESSMENT -> APPROVED (v13)

# Advance to payout and closure
advance CLM-LOOP PAYMENT_INITIATED -r finance -u finance-frank
advance CLM-LOOP CLOSED -r finance -u finance-frank -s paymentConfirmed=true -s paymentReference=PAY-LOOP-01
```

---

## 8. Test Suite 7: Illegal State Jumps & Terminal Immutability

**Objective**: Verify that arbitrary state jumping is rejected and terminal states (`CLOSED`) cannot be mutated.

```bash
# 1. Create fresh claim (Current state: SUBMITTED)
create -i CLM-JUMP --amount 1000 --limit 5000 --docs claim_form,medical_report,itemized_receipt

# 2. Negative Test: Try to jump directly from SUBMITTED to APPROVED
advance CLM-JUMP APPROVED -r assessor -u assessor-alice
# Output: [DENIED] Transition 'SUBMITTED -> APPROVED' is not allowed. Allowed transitions from 'SUBMITTED': DOCUMENTS_VERIFIED (role: document_clerk)

# 3. Negative Test: Try to transition to a non-existent state
advance CLM-JUMP ARBITRARY_STATE -r document_clerk
# Output: [DENIED] Transition 'SUBMITTED -> ARBITRARY_STATE' is not allowed ('ARBITRARY_STATE' is not a defined workflow state)

# 4. Fast-forward CLM-JUMP to CLOSED
advance CLM-JUMP DOCUMENTS_VERIFIED -r document_clerk -u clerk-bob
advance CLM-JUMP UNDER_ASSESSMENT -r team_lead -u lead-sarah -s assessorId=assessor-alice
advance CLM-JUMP APPROVED -r assessor -u assessor-alice -s assessmentReportComplete=true
advance CLM-JUMP PAYMENT_INITIATED -r finance -u finance-frank
advance CLM-JUMP CLOSED -r finance -u finance-frank -s paymentConfirmed=true -s paymentReference=PAY-JUMP-01

# 5. Negative Test: Try to transition OUT of terminal state CLOSED
advance CLM-JUMP SUBMITTED -r document_clerk
# Output: [DENIED] Cannot transition claim 'CLM-JUMP' from 'CLOSED' to 'SUBMITTED': state 'CLOSED' is terminal and allows no further transitions
```

---

## 9. Test Suite 8: Optimistic Concurrency & Idempotency Retries

**Objective**: Verify concurrent collision prevention (`--expected-version`) and idempotent duplicate retries (`--idempotency-key`).

```bash
# 1. Create claim (version 1)
create -i CLM-LOCK --amount 2000 --limit 5000 --docs claim_form,medical_report,itemized_receipt

# 2. Negative Test: Concurrency conflict (claim is at v1, client specifies expected-version 99)
advance CLM-LOCK DOCUMENTS_VERIFIED -r document_clerk -u clerk-bob --expected-version 99
# Output: [DENIED] Concurrency conflict: expected version 99, but current version is 1

# 3. Success Test: Valid expected-version 1
advance CLM-LOCK DOCUMENTS_VERIFIED -r document_clerk -u clerk-bob --expected-version 1 --idempotency-key IDEM-001
# Output: [OK] SUBMITTED -> DOCUMENTS_VERIFIED (v2)

# 4. Idempotency Test: Re-send exact same command with same idempotency key
advance CLM-LOCK DOCUMENTS_VERIFIED -r document_clerk -u clerk-bob --expected-version 1 --idempotency-key IDEM-001
# Output: [OK (IDEMPOTENT REPLAY)] Returns cached transition result with zero duplicate state modification or audit entries!
```

---

## 10. Test Suite 9: Extensibility Demo (`FRAUD_CHECK` & `fraud_analyst`)

To test the extended workflow, exit the CLI with `exit` and restart with the fraud config:

```bash
npm start -- --config config/claims-workflow.fraud-check.yaml
```

### A. Low-Risk Claim (`score = 25 <= 70`): Passes Fraud Gate

```bash
# 1. Create low-risk claim
create -i CLM-FRAUD-LOW --amount 3500 --limit 10000 --docs claim_form,medical_report,itemized_receipt

# 2. Advance to DOCUMENTS_VERIFIED
advance CLM-FRAUD-LOW DOCUMENTS_VERIFIED -r document_clerk -u clerk-bob

# 3. Advance to new extension state: FRAUD_CHECK
advance CLM-FRAUD-LOW FRAUD_CHECK -r document_clerk -u clerk-bob
# Output: [OK] DOCUMENTS_VERIFIED -> FRAUD_CHECK (v3)

# 4. Inspect claim: Shows FRAUD_CHECK state with required role fraud_analyst
show CLM-FRAUD-LOW

# 5. Clear fraud check: score = 25 <= 70, assign assessor
advance CLM-FRAUD-LOW UNDER_ASSESSMENT -r fraud_analyst -u analyst-carol -s fraudRiskScore=25 -s assessorId=assessor-alice
# Output: [OK] FRAUD_CHECK -> UNDER_ASSESSMENT (v4)
# Side-effect triggered: fraudCleared: true, assessmentStartedAt timestamp recorded!

# 6. Proceed to approval
advance CLM-FRAUD-LOW APPROVED -r assessor -u assessor-alice -s assessmentReportComplete=true
```

### B. High-Risk Claim (`score = 92 > 70`): Fast-Fail Rejection

```bash
# 1. Create high-risk claim
create -i CLM-FRAUD-HIGH --amount 8500 --limit 10000 --docs claim_form,medical_report,itemized_receipt
advance CLM-FRAUD-HIGH DOCUMENTS_VERIFIED -r document_clerk -u clerk-bob
advance CLM-FRAUD-HIGH FRAUD_CHECK -r document_clerk -u clerk-bob

# 2. Negative Test: Try to pass fraud check with high risk score (92 > 70)
advance CLM-FRAUD-HIGH UNDER_ASSESSMENT -r fraud_analyst -u analyst-carol -s fraudRiskScore=92 -s assessorId=assessor-alice
# Output: [DENIED] Precondition check failed: Fraud risk score within acceptable threshold (0 to 70)

# 3. Success Fast-Fail: Fraud analyst rejects the fraudulent claim
advance CLM-FRAUD-HIGH REJECTED -r fraud_analyst -u analyst-carol -s fraudRiskScore=92 -s rejectionReason="Identity mismatch and altered invoice detected"
# Output: [OK] FRAUD_CHECK -> REJECTED (v4)
# Side-effect triggered: Outbox compliance notification dispatched to applicant!

# 4. Inspect outbox events for compliance notification
outbox CLM-FRAUD-HIGH
```

---

## 11. Test Suite 10: Input Validation Guardrails

**Objective**: Verify that negative/zero/non-numeric monetary values, malformed IDs, invalid flags, and backwards clock mutations are rejected before corrupting state.

```bash
# Negative or zero claim amounts / policy limits (Rejected immediately)
create --amount -3000 --docs claim_form
create --amount 0
create --policy-limit -500
create --amount abc

# Invalid Claim IDs & malformed flags (Rejected immediately)
create -i "bad id with spaces"
clock -5
clock 0
```

---

## 12. Handy Inspection Commands

| Command | Description | Example |
| :--- | :--- | :--- |
| `list` | View all active claims, states, versions, and amounts | `list` |
| `show <claimId>` | View claim state, fields, and list valid transitions with required roles | `show CLM-HAPPY` |
| `audit <claimId>` | View complete immutable audit trail and event-sourcing replay verification | `audit CLM-HAPPY` |
| `outbox [claimId]` | View all queued and dispatched side-effects with status and payloads | `outbox CLM-HAPPY` |
| `clock [days]` | View current simulated timestamp or advance clock by days | `clock +31` |
| `workflow` | View workflow summary (all states, roles, transitions, cycle rules) | `workflow` |
| `seed` | Populate session with 3 pre-configured demo claims (`C-HAPPY`, `C-ASSESS`, `C-REJECTED`) | `seed` |
| `exit` | Exit the CLI session | `exit` |
