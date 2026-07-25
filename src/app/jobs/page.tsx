import { Card } from "@/components/Card";
import { StatusBadge } from "@/components/StatusBadge";
import { getDashboardData } from "@/lib/dashboard/data";

export const dynamic = "force-dynamic";

export default async function JobsPage() {
  const data = await getDashboardData();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-zinc-50">Job Runs</h1>
      
      <Card>
        {data.jobs.length === 0 ? (
          <p className="text-sm text-zinc-500 py-4 text-center">No database records found. Currently using demo fallback.</p>
        ) : (
          <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr>
                  <th>Job Name</th>
                  <th>Status</th>
                  <th>Started At</th>
                  <th className="text-right">Duration</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {data.jobs.map((job) => (
                  <tr key={job.id}>
                    <td className="font-medium text-zinc-300">{job.name}</td>
                    <td>
                      <StatusBadge status={job.status} />
                    </td>
                    <td className="text-zinc-400">{new Date(job.startedAt).toLocaleString("zh-CN")}</td>
                    <td className="text-right text-zinc-400">{job.durationMs}ms</td>
                    <td className="text-zinc-500 max-w-xs truncate" title={job.error ?? undefined}>
                      {job.error ?? "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
