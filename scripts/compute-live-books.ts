import { refreshLiveBooks } from "@/lib/fund/liveBooks";

async function main() {
  const t0 = Date.now();
  const result = await refreshLiveBooks();
  console.log(
    `live-books ${result.books.map((b) => `${b.name} 自 ${b.view.since} ${b.view.pnl}`).join(" · ")} ${Date.now() - t0}ms`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
