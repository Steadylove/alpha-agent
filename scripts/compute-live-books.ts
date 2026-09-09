import { refreshLiveBooks } from "@/lib/fund/liveBooks";

async function main() {
  const t0 = Date.now();
  const result = await refreshLiveBooks();
  console.log(
    `live-books ${result.epochFrom} → ${result.books.map((b) => `${b.name} ${b.view.pnl}`).join(" · ")} ${Date.now() - t0}ms`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
