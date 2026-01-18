import { exec } from "child_process";
import * as esbuild from "esbuild";

const isServe = process.argv.includes("--serve");

function packZip() {
  exec("node ./pack-zip.js", (err, stdout, stderr) => {
    if (err) {
      console.error("Error packing zip:", err);
      return;
    }
    console.log(stdout.trim());
  });
}

const zipPlugin = {
  name: "zip-plugin",
  setup(build) {
    build.onEnd(() => {
      packZip();
    });
  },
};

let buildConfig = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  minify: !isServe,
  logLevel: "info",
  color: true,
  outdir: "dist",
  plugins: [zipPlugin],
  resolveExtensions: ['.ts', '.d.ts']
};

(async function () {
  if (isServe) {
    console.log("Starting development server...");

    const ctx = await esbuild.context(buildConfig);
    await ctx.watch();
    await ctx.serve({ servedir: ".", port: 3080 });

  } else {
    console.log("Building for production...");
    await esbuild.build(buildConfig);
    console.log("Production build complete.");
  }
})();