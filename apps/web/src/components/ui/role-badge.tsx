import { cn } from "@/lib/utils";

export type Role = "owner" | "admin" | "member" | "viewer";

const roleConfig: Record<Role, { label: string; className: string }> = {
  owner: { label: "Owner", className: "role-badge owner" },
  admin: { label: "Admin", className: "role-badge admin" },
  member: { label: "Member", className: "role-badge member" },
  viewer: { label: "Viewer", className: "role-badge viewer" },
};

export function RoleBadge({
  role,
  className,
}: {
  role: Role;
  className?: string;
}) {
  const config = roleConfig[role];
  return <span className={cn(config.className, className)}>{config.label}</span>;
}
