export function StatusBadge({ status }: { status: string }) {
  let colorClass = "bg-zinc-800 text-zinc-400 border-zinc-700/50";
  
  if (status === "FOCUS") {
    colorClass = "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
  } else if (status === "WATCH") {
    colorClass = "bg-blue-500/10 text-blue-400 border-blue-500/20";
  } else if (status === "NEW") {
    colorClass = "bg-amber-500/10 text-amber-400 border-amber-500/20";
  } else if (status === "DOWNGRADED") {
    colorClass = "bg-rose-500/10 text-rose-400 border-rose-500/20";
  } else if (status === "SUCCESS") {
    colorClass = "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
  } else if (status === "FAILED") {
    colorClass = "bg-rose-500/10 text-rose-400 border-rose-500/20";
  } else if (status === "PARTIAL") {
    colorClass = "bg-amber-500/10 text-amber-400 border-amber-500/20";
  }

  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium border ${colorClass}`}>
      {status}
    </span>
  );
}
