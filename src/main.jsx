import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./relatorio.css";

// No relatorio.html os dados vêm embutidos; no `npm run dev`, de saida/dados.json; na Vercel,
// de public/dados.json (gravado pela rodada automática do GitHub Actions).
async function carregar() {
  const embutidos = JSON.parse(document.getElementById("dados").textContent);
  if (embutidos) return embutidos;
  const r = await fetch("/dados.json");
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

const raiz = createRoot(document.getElementById("root"));
carregar().then(
  (dados) => raiz.render(<App dados={dados} />),
  (e) => raiz.render(<p className="vazio">Sem dados: {e.message}</p>),
);
