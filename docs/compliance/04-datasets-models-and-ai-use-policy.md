# 04 - Datasets, Models And AI Use Policy

## Dataset Handling

Customer datasets may be used for RAG, fine-tuning, evaluation or private inference projects. Each dataset must have:

- customer owner;
- project ID;
- purpose;
- data classification;
- retention period;
- allowed processing environment;
- external worker permission flag;
- deletion deadline;
- access list.

## Dataset Classification

| Level | Examples | Controls |
| --- | --- | --- |
| Public | Public docs, marketing pages | Standard processing. |
| Internal | Non-public company docs | Authenticated project access and deletion schedule. |
| Confidential | Legal, finance, contracts, industrial docs | Private pool or no-retention recommended. |
| Sensitive | Health, biometric, defense-sensitive, regulated data | Legal review, private/dedicated processing, no external workers by default. |

## External Worker Rule

Default for sensitive enterprise projects:

```text
No external worker may process customer datasets or prompts unless the contract explicitly allows it.
```

Allowed modes:

- Vryx-controlled infrastructure only;
- customer-approved private workers;
- dedicated worker pool;
- redacted/synthetic test data for external benchmarking.

## Model Usage Terms

For each model offered commercially, Vryx should track:

- model name and version;
- provider/license;
- commercial-use permission;
- restrictions on regulated use;
- attribution requirements;
- data retention/training implications;
- whether outputs can be used commercially;
- required disclaimers.

No model should be listed as generally available for enterprise use until its license and usage restrictions have been checked.

## Prohibited Or Restricted Use

The customer contract and product policy should restrict:

- illegal content generation;
- unauthorized surveillance;
- credential theft, malware or exploit generation;
- medical, legal or financial advice without appropriate human review;
- weapons targeting or harmful defense applications;
- processing data without required rights or consent;
- attempts to extract worker secrets, model weights or platform internals.

## Health, Finance, Legal And Defense Notes

| Sector | Requirement |
| --- | --- |
| Legal | Confidentiality, no-retention, DPA, access logs, private pool option. |
| Automotive/industry | IP protection, dataset isolation, worker restrictions, audit logs. |
| Health | Special-category data review, no external workers by default, strong deletion evidence. |
| Finance | Auditability, access logs, retention, incident response, data location controls. |
| Defense-adjacent | Strict scope review, export/control review, no public worker processing by default. |

## Project Closeout

At project end:

1. stop processing;
2. export deliverables if required;
3. delete or return datasets;
4. revoke project-specific access;
5. record deletion evidence;
6. preserve only legal/accounting/security records.

