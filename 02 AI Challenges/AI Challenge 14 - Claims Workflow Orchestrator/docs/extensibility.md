# Workflow Extensibility Proof — Fraud Check Extension

This document provides formal proof of the config-driven extensibility of the Claims Workflow Orchestrator. A new business stage (`FRAUD_CHECK`), a new user role (`fraud_analyst`), and automated risk score precondition gates were introduced **strictly via configuration**, with **0 lines of engine code modified**.

---

## 1. Summary of Changes

| Metric | Base Workflow (`claims-workflow.yaml`) | Extended Workflow (`claims-workflow.fraud-check.yaml`) | Delta |
| :--- | :--- | :--- | :--- |
| **Workflow Version** | `1.0.0` | `1.1.0` | Minor version bump |
| **Total States** | 8 | 9 (`FRAUD_CHECK` added) | +1 state |
| **User Roles** | 5 | 6 (`fraud_analyst` added) | +1 role |
| **Transitions** | 10 | 12 | +2 transitions |
| **Preconditions** | 13 | 16 | +3 precondition checks |
| **Engine Code Changes** | — | — | **0 lines of code** |

---

## 2. Configuration Unified Diff

```diff
--- config/claims-workflow.yaml (v1.0.0)
+++ config/claims-workflow.fraud-check.yaml (v1.1.0)
@@ -1,5 +1,5 @@
-name: Insurance Claims Lifecycle Workflow
-version: "1.0.0"
+name: Insurance Claims Lifecycle Workflow (with Fraud Check Extension)
+version: "1.1.0"
 initialState: SUBMITTED
 
 defaults:
@@ -10,6 +10,7 @@
 
 roles:
   - document_clerk
+  - fraud_analyst
   - team_lead
   - assessor
   - finance
@@ -20,6 +21,8 @@
     description: Claim received, awaiting document verification
   DOCUMENTS_VERIFIED:
     description: All required documents confirmed present and valid
+  FRAUD_CHECK:
+    description: Automated and analyst fraud risk screening in progress
   UNDER_ASSESSMENT:
     description: Assessor is reviewing the claim
   PENDING_INFO:
@@ -50,23 +53,70 @@
               requiredPath: effective.requiredDocuments
     sideEffects:
       - type: notify
-        target: assessor_team
-        message: "Claim {{claim.id}} documents verified; ready for assessor assignment"
+        target: fraud_team
+        message: "Claim {{claim.id}} documents verified; routed to fraud screening"
 
   - from: DOCUMENTS_VERIFIED
+    to: FRAUD_CHECK
+    roles:
+      - document_clerk
+    preconditions:
+      - description: Required documents verified for fraud screening
+        check:
+          op: not_empty
+          path: effective.submittedDocuments
+    sideEffects:
+      - type: record_timestamp
+        field: fraudCheckStartedAt
+        message: "Started fraud check for claim {{claim.id}}"
+
+  - from: FRAUD_CHECK
     to: UNDER_ASSESSMENT
     roles:
+      - fraud_analyst
       - team_lead
     preconditions:
+      - description: Fraud risk score within acceptable threshold (0 to 70)
+        check:
+          all_of:
+            - op: gte
+              path: effective.fraudRiskScore
+              value: 0
+            - op: lte
+              path: effective.fraudRiskScore
+              value: 70
       - description: Assessor assigned
         check:
           op: not_empty
           path: effective.assessorId
     sideEffects:
+      - type: set_field
+        field: fraudCleared
+        value: true
+        message: "Fraud check cleared for claim {{claim.id}} (score: {{effective.fraudRiskScore}})"
       - type: record_timestamp
         field: assessmentStartedAt
         message: "Logged assessment start time for claim {{claim.id}} (assessor: {{effective.assessorId}})"
 
+  - from: FRAUD_CHECK
+    to: REJECTED
+    roles:
+      - fraud_analyst
+    preconditions:
+      - description: High fraud risk score (> 70)
+        check:
+          op: gt
+          path: effective.fraudRiskScore
+          value: 70
+      - description: Rejection reason provided
+        check:
+          op: not_empty
+          path: effective.rejectionReason
+    sideEffects:
+      - type: notify
+        target: member
+        message: "Claim {{claim.id}} rejected during compliance screening ({{effective.rejectionReason}}). Appeal instructions: submit appeal within 30 days."
+
   - from: UNDER_ASSESSMENT
     to: APPROVED
     roles:
@@ -206,6 +256,7 @@
       - UNDER_ASSESSMENT
       - PENDING_INFO
       - DOCUMENTS_VERIFIED
+      - FRAUD_CHECK
       - UNDER_ASSESSMENT
     maxCycles: 3
     errorMessage: "Maximum information requests exceeded — escalate to team lead"
```

---

## 3. Automated Extensibility Verification

The extended workflow was verified with automated test suites in [`tests/integration/extensibility.test.ts`](../tests/integration/extensibility.test.ts):

1. **Low-Risk Claim Execution (`score = 18 <= 70`)**:
   - `SUBMITTED` -> `DOCUMENTS_VERIFIED`
   - `DOCUMENTS_VERIFIED` -> `FRAUD_CHECK`
   - `FRAUD_CHECK` -> `UNDER_ASSESSMENT` (Precondition passes; `fraudCleared: true` side-effect recorded)
   - Proceeds through standard assessment and approval lifecycle.
2. **High-Risk Claim Execution (`score = 92 > 70`)**:
   - `DOCUMENTS_VERIFIED` -> `FRAUD_CHECK`
   - Attempt `FRAUD_CHECK` -> `UNDER_ASSESSMENT` fails with precondition error: `Fraud risk score within acceptable threshold (0 to 70)`
   - `FRAUD_CHECK` -> `REJECTED` by `fraud_analyst` succeeds and dispatches compliance notification to applicant.

