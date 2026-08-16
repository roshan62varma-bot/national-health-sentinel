import { Link } from "@tanstack/react-router";
import { Activity, Globe2, LayoutDashboard, Radio, Smartphone } from "lucide-react";
import { PulseStrip } from "./pulse-strip";

const nav = [
  { to: "/", label: "National Command", icon: LayoutDashboard },
  { to: "/resource/$resource", params: { resource: "medicine" }, label: "Resources", icon: Activity },
  { to: "/brics", label: "BRICS Network", icon: Globe2 },
  { to: "/field", label: "Field PWA", icon: Smartphone },
] as const;

export function ConsoleShell({
  breadcrumb,
  pulse,
  children,
}: {
  breadcrumb: string;
  pulse: { stockRisk: number; bedRisk: number; staffRisk: number };
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen bg-background">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-card md:flex">
        <div className="flex items-center gap-2 border-b border-border px-4 py-4">
          <span className="grid size-7 place-items-center rounded-sm bg-primary text-primary-foreground">
            <Radio className="size-4" />
          </span>
          <div>
            <div className="text-sm font-semibold leading-tight">AegisHealth</div>
            <div className="readout text-[10px] uppercase tracking-widest text-muted-foreground">BRICS</div>
          </div>
        </div>
        <nav className="flex flex-col gap-1 p-2">
          {nav.map((item) => {
            const cls =
              "flex items-center gap-2 rounded-sm px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground";
            const active = { className: "bg-secondary text-foreground font-medium" };
            const body = (
              <>
                <item.icon className="size-4" />
                {item.label}
              </>
            );
            return "params" in item ? (
              <Link key={item.label} to={item.to} params={item.params} className={cls} activeProps={active}>
                {body}
              </Link>
            ) : (
              <Link
                key={item.label}
                to={item.to}
                activeOptions={{ exact: item.to === "/" }}
                className={cls}
                activeProps={active}
              >
                {body}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto p-3 text-[11px] leading-relaxed text-muted-foreground">
          Signed in as <span className="text-foreground">NATIONAL_MINISTRY_ADMIN</span>
          <br />
          Scope: Nation (India)
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <PulseStrip
          {...pulse}
          right={
            <div className="readout hidden shrink-0 items-center gap-2 text-[11px] text-muted-foreground sm:flex">
              <span className="size-1.5 rounded-full bg-risk-stable" />
              LIVE · {breadcrumb}
            </div>
          }
        />
        <main className="min-w-0 flex-1 p-4">{children}</main>
      </div>
    </div>
  );
}