// Seed playbook template: "30-Day Sprint — $60k & 20 SQLs".
// weeks_json shape: { weeks: [{ theme, roles: { CEO: [tasks...], ... } }],
//                     kpis: [{ name, unit, targets: [w1, w2, w3, w4] }] }

export const SEED_PLAYBOOK = {
  name: "30-Day Sprint — $60k & 20 SQLs",
  description:
    "Close $60,000 in revenue and generate 20 qualified leads in 30 days via $5k Audit & Onboarding packages (consulting + software seats).",
  weeks: [
    {
      theme: "Technical Setup & Pod Packaging",
      roles: {
        CEO: [
          "Finalize $5k Audit & Setup SOW template with counsel",
          "Reserve 480 consulting hours of delivery capacity",
          "Set up Mon/Wed/Fri executive revenue standups",
        ],
        CRO: [
          "Build verified ICP list of 400 B2B targets",
          "Finalize outbound copy (cold email + LinkedIn + phone)",
          "Configure CRM pipeline stages",
        ],
        CTO: [
          "Build workspace provisioning automation (5-min onboarding)",
          "Link Stripe payment webhooks to CRM attribution",
          "Warm up outreach domains (SPF, DKIM, DMARC)",
        ],
        COO: [
          "Standardize the 7-day diagnostic audit playbook",
          "Confirm 6–10 fractional consultants for weeks 3–4",
          "Deploy client intake forms and deliverable portals",
        ],
      },
    },
    {
      theme: "Outbound Launch & Lead Capture",
      roles: {
        CEO: [
          "Contact 5 venture funds / accelerators for portfolio audits",
          "Reach out to top 10 personal executive contacts",
        ],
        CRO: [
          "Enroll 50 prospects/day into outbound cadences (400 total)",
          "Qualify accounts: 10+ reps, stack pain, $5k authority",
          "Book 18 discovery calls",
        ],
        CTO: [
          "Run platform load and multi-tenant security tests",
          "Verify third-party API margins ($6/seat budget)",
        ],
        COO: [
          "Brief delivery team on audit metrics and SLAs",
          "Establish 24-hour response SLA for inbound requests",
        ],
      },
    },
    {
      theme: "Discovery Calls & Diagnostic Audits",
      roles: {
        CEO: [
          "Mid-sprint financial review vs working capital",
          "Join high-value sales calls as executive sponsor",
        ],
        CRO: [
          "Deliver 20 diagnostic pitches off discovery calls",
          "Log 20 cumulative SQLs in CRM",
          "Close first 5 anchor packages ($25k)",
        ],
        CTO: [
          "Oversee workspace deployment for first 5 accounts",
          "Monitor seat activation telemetry",
        ],
        COO: [
          "Launch 7-day diagnostic audits for first 5 accounts",
          "Schedule week-4 adoption workshops with client managers",
        ],
      },
    },
    {
      theme: "Closing Sprints & Retainer Lock",
      roles: {
        CEO: [
          "Final cash collection review vs $60k goal",
          "Legal & compliance audit of executed contracts",
        ],
        CRO: [
          "Close remaining 7 anchor packages ($35k)",
          "Pitch monthly retainers to week-3 audit clients",
        ],
        CTO: [
          "Complete onboarding for all 12 clients (240 seats)",
          "Log feature requests into engineering backlog",
        ],
        COO: [
          "Deliver all 12 diagnostic reports and decks",
          "Transition closed accounts to Customer Success",
        ],
      },
    },
  ],
  kpis: [
    { name: "Outbound Emails/DMs", unit: "sent", targets: [100, 300, 400, 400] },
    { name: "Discovery Calls", unit: "calls", targets: [0, 18, 30, 40] },
    { name: "SQLs", unit: "leads", targets: [0, 10, 18, 20] },
    { name: "Closed Packages", unit: "deals", targets: [0, 0, 5, 12] },
    { name: "Active Seats", unit: "seats", targets: [0, 0, 100, 240] },
  ],
};
