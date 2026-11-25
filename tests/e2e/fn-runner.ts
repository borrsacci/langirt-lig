// Edge Function'ı yerelde belirli bir portta çalıştırır (sadece test)
const port = Number(Deno.env.get('PORT'));
const orig = Deno.serve.bind(Deno);
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (h: any) => orig({ port, hostname: '127.0.0.1', onListen: () => console.log('fn on', port) }, h);
await import(new URL(Deno.env.get('FN')!, `file://${Deno.cwd()}/`).href);
