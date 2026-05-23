# 06 - Video Proof Checklist

## Target Format

Length: 3 to 5 minutes.

Goal: show that Vryx is a distributed AI infrastructure that is live, measurable and billable.

## Storyboard

| Time | Scene | Proof |
| --- | --- | --- |
| 0:00-0:25 | Homepage / positioning | Vryx is distributed AI inference infrastructure. |
| 0:25-0:55 | Public network page | Workers live, models available, redacted network proof. |
| 0:55-1:30 | Production readiness | Score, golden path, TPS, TTFT, zero empty responses. |
| 1:30-2:05 | Admin models/pricing | Dynamic pricing controlled from admin. |
| 2:05-2:45 | API request | OpenAI-compatible request and non-empty AI response. |
| 2:45-3:25 | Money path | Credits debited, usage cost, pricing snapshot. |
| 3:25-3:55 | Worker payout | Pending worker reward from successful inference. |
| 3:55-4:30 | CI/bench | GitHub Actions and benchmark artifact. |
| 4:30-5:00 | Close | Vryx turns distributed compute into billable AI capacity. |

## Must-Show Screens

- `/network`
- `/admin/production-readiness`
- `/admin/parametres/pricing`
- `/compte`
- `/admin/billing` or billing proof endpoint output
- `/admin/workers`
- GitHub Actions benchmark run
- API client or terminal request/response

## Evidence To Capture

| Evidence | Required |
| --- | --- |
| Two active workers | Yes |
| Readiness score | Yes |
| Real benchmark | Yes |
| API request body | Yes |
| AI response | Yes |
| Tokens and latency | Yes |
| Cost in EUR | Yes |
| Credit debit | Yes |
| Worker payout pending | Yes |
| Pricing snapshot | Yes |
| CI workflow green | Yes |

## Suggested Voiceover

```text
Vryx is a distributed AI inference infrastructure.
Customers use an OpenAI-compatible API.
The network routes requests to live workers, measures tokens, latency and throughput, bills the customer, and calculates the worker payout.
This demo shows the full golden path: network readiness, two active workers, a real API request, a non-empty AI response, dynamic pricing, credit debit, worker payout and CI benchmark evidence.
```

## Final Investor Line

```text
Vryx is not only an AI demo. It is a measurable, observable and billable infrastructure layer for distributed inference.
```

