import { Card } from "@/components/Card";

const settings = [
  { key: "DATABASE_URL", required: true, description: "PostgreSQL Connection String" },
  { key: "DISCORD_WEBHOOK_URL", required: true, description: "Discord Webhook for Reports" },
  { key: "CRON_SECRET", required: true, description: "API Auth Secret for CRON" },
  { key: "FMP_API_KEY", required: false, description: "Financial Modeling Prep API Key" },
  { key: "FRED_API_KEY", required: false, description: "FRED Macro API Key" },
  { key: "FINNHUB_API_KEY", required: false, description: "Finnhub API Key for News" },
];

export default function SettingsPage() {
  return (
    <div className="space-y-6 max-w-4xl">
      <h1 className="text-2xl font-semibold text-zinc-50">Configuration</h1>
      
      <Card title="Environment Variables">
        <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th>Variable</th>
                <th>Required</th>
                <th>Status</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {settings.map((setting) => (
                <tr key={setting.key}>
                  <td className="font-mono text-zinc-300 text-xs">{setting.key}</td>
                  <td className="text-zinc-400">{setting.required ? "Yes" : "No"}</td>
                  <td>
                    <span className={`inline-flex items-center rounded-sm px-2 py-0.5 text-xs font-medium ${process.env[setting.key] ? 'bg-zinc-800 text-zinc-300' : 'text-zinc-500'}`}>
                      {process.env[setting.key] ? "Configured" : "Missing"}
                    </span>
                  </td>
                  <td className="text-zinc-500">{setting.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Trigger Webhook Manually">
        <pre className="overflow-x-auto rounded-md bg-[#09090b] border border-zinc-800 p-4 text-xs font-mono text-zinc-400">
{`curl -X POST http://localhost:3000/api/jobs/daily-report \\
  -H "x-cron-secret: $CRON_SECRET"`}
        </pre>
      </Card>
    </div>
  );
}
