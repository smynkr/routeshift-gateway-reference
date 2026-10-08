export const AUDIT_EVENT_TYPES = [
	"created",
	"updated",
	"revoked",
	"rotated",
	"auth_failed",
	"rate_limited",
	"budget_exceeded",
	"sso_issued",
] as const;

const EVENT_LABEL: Record<(typeof AUDIT_EVENT_TYPES)[number], string> = {
	created: "Created",
	updated: "Updated",
	revoked: "Revoked",
	rotated: "Rotated",
	auth_failed: "Auth failed",
	rate_limited: "Rate limited",
	budget_exceeded: "Budget exceeded",
	sso_issued: "SSO issued",
};

export function auditEventLabel(eventType: string): string {
	return Object.hasOwn(EVENT_LABEL, eventType)
		? EVENT_LABEL[eventType as (typeof AUDIT_EVENT_TYPES)[number]]
		: eventType;
}

export function auditEventBadgeStyle(eventType: string): string {
	switch (eventType) {
		case "created":
			return "bg-emerald-500/[0.12] text-emerald-300";
		case "updated":
			return "bg-teal-500/[0.12] text-teal-300";
		case "revoked":
			return "bg-red-500/[0.12] text-red-300";
		case "auth_failed":
			return "bg-amber-500/[0.12] text-amber-300";
		case "rate_limited":
		case "budget_exceeded":
			return "bg-orange-500/[0.12] text-orange-300";
		case "rotated":
			return "bg-sky-500/[0.12] text-sky-300";
		case "sso_issued":
			return "bg-violet-500/[0.12] text-violet-300";
		default:
			return "bg-neutral-500/[0.12] text-neutral-300";
	}
}
