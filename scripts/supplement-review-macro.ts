import { supplementMacroReviews } from "@/lib/review/supplementMacro";

supplementMacroReviews()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    if (result.errors.length) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "宏观补采失败");
    process.exitCode = 1;
  });
