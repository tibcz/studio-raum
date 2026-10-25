import type { MemberRole, TeamMember } from "./models";

export type Permission = "participate" | "manageBookings" | "manageTeam";

export function canManageBookings(role: MemberRole): boolean {
  return role === "admin" || role === "owner";
}

export function canManageTeam(role: MemberRole): boolean {
  return role === "admin" || role === "owner";
}

export function allows(
  member: Pick<TeamMember, "role" | "isActive">,
  permission: Permission,
): boolean {
  if (!member.isActive) return false;
  switch (permission) {
    case "participate":
      return true;
    case "manageBookings":
      return canManageBookings(member.role);
    case "manageTeam":
      return canManageTeam(member.role);
  }
}
