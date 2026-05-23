# 05 - Enterprise Contract Checklist

Use this checklist before sending a contract to law firms, automotive, industry, health, finance or defense-adjacent buyers.

## Documents To Attach

| Document | Status |
| --- | --- |
| DPA | Draft exists, legal validation required. |
| Security architecture | Exists, keep updated with implementation. |
| Processing register | Exists in this pack, DPO/legal review required. |
| Retention/deletion policy | Exists in this pack, product enforcement required. |
| Incident response | Exists, needs owner and communication templates. |
| Worker terms | Draft exists, legal validation required. |
| Subprocessor list | Must be finalized per deployment. |
| Model terms appendix | Must be generated from active model catalog. |
| Dataset handling appendix | Exists as policy, project-specific schedule required. |

## Contract Clauses To Confirm

- customer instructions and Vryx processor role;
- data categories and processing purposes;
- subprocessors and approval process;
- external worker permission or prohibition;
- retention duration;
- deletion or return at end of contract;
- no-retention mode if selected;
- security measures;
- audit rights and evidence format;
- incident notification timelines;
- liability and indemnity;
- model license restrictions;
- acceptable use;
- support/SLA;
- payment, credits and refunds;
- worker payout is not customer-facing unless part of private pool terms.

## Technical Configuration Before Go-Live

| Control | Required For Sensitive Clients |
| --- | --- |
| `COOKIE_SECURE=true` | Yes |
| strong `JWT_SECRET` | Yes |
| worker auth required | Yes |
| internal token required | Yes |
| public network redaction | Yes |
| no-retention flag | If contracted |
| external workers disabled | If contracted |
| private pool routing | If contracted |
| dataset isolation | Yes |
| access logs enabled | Yes |
| backup policy documented | Yes |
| incident contact configured | Yes |

## Sales Qualification Questions

Ask before quoting:

- What data will be sent to Vryx?
- Is any data personal, confidential, regulated or export-controlled?
- Must prompts/responses be no-retention?
- Are external workers allowed?
- Is EU-only processing required?
- What SLA and latency target are expected?
- Are logs and audit exports required?
- Is a DPA required before pilot?
- Are model license restrictions acceptable?
- Who signs security and data protection terms?

## Go / No-Go Rule

Do not accept sensitive regulated production data until:

- DPA is signed;
- retention/no-retention configuration is clear;
- worker routing policy is clear;
- incident contact is known;
- dataset deletion process is tested;
- security owner approves the project.

