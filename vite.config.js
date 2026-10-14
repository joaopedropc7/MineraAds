import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// No `npm run dev`, o relatório lê os dados da última rodada em saida/dados.json.
const dadosDaRodada = {
  name: "dados-da-rodada",
  configureServer(server) {
    server.middlewares.use("/dados.json", (req, res) => {
      const arq = path.resolve(process.cwd(), "saida", "dados.json");
      if (!fs.existsSync(arq)) {
        res.statusCode = 404;
        res.end("Rode o minerador primeiro (npm run minerar).");
        return;
      }
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(fs.readFileSync(arq));
    });
  },
};

// Build num arquivo só (JS e CSS embutidos): o minerador coloca os dados dentro dele e o
// saida/relatorio.html abre com dois cliques, sem servidor.
export default defineConfig({
  plugins: [react(), viteSingleFile(), dadosDaRodada],
  build: { outDir: "dist", emptyOutDir: true },
});
