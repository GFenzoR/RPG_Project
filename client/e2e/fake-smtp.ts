// A minimal SMTP sink for the E2E suite (T2.1): the email server of the mail E2E game
// server. It accepts plain SMTP (SMTP_SECURITY=none, like Mailpit) and keeps each message.
// GET http://127.0.0.1:<http port>/messages returns them, newest last, as
// [{to, subject, text}] where text is the decoded text/plain part.
//
//   node e2e/fake-smtp.ts <smtp port> <http port>
import { createServer as createHttp } from "node:http";
import { createServer as createTcp } from "node:net";

interface Sunk {
  to: string;
  subject: string;
  text: string;
}

const [smtpPort, httpPort] = process.argv.slice(2).map(Number);
if (!smtpPort || !httpPort) throw new Error("usage: fake-smtp.ts <smtp port> <http port>");
const messages: Sunk[] = [];

/** Decodes quoted-printable (soft line breaks and =XX bytes as UTF-8). */
function decodeQP(s: string): string {
  const bytes: number[] = [];
  const src = s.replace(/=\r?\n/g, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i] ?? "";
    if (c === "=" && /^[0-9A-F]{2}$/i.test(src.slice(i + 1, i + 3))) {
      bytes.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...new TextEncoder().encode(c));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Decodes an RFC 2047 =?utf-8?q?...?= header (what Go's mime.QEncoding writes). */
function decodeHeader(v: string): string {
  return v.replace(/=\?utf-8\?q\?([^?]*)\?=\s*/gi, (_, q: string) =>
    decodeQP(q.replace(/_/g, " ")),
  );
}

function parse(to: string, data: string): Sunk {
  const [head = "", ...rest] = data.split("\r\n\r\n");
  const subject = decodeHeader(/^Subject: (.*)$/m.exec(head)?.[1] ?? "");
  const body = rest.join("\r\n\r\n");
  const plain = /Content-Type: text\/plain[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n([\s\S]*?)\r\n--/.exec(
    body,
  );
  return { to, subject, text: decodeQP(plain?.[1] ?? "") };
}

createTcp((sock) => {
  let buf = "";
  let to = "";
  let inData = false;
  const say = (l: string): void => void sock.write(`${l}\r\n`);
  say("220 fake-smtp");
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    for (;;) {
      if (inData) {
        const end = buf.indexOf("\r\n.\r\n");
        if (end < 0) return;
        messages.push(parse(to, buf.slice(0, end)));
        buf = buf.slice(end + 5);
        inData = false;
        say("250 queued");
        continue;
      }
      const nl = buf.indexOf("\r\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const cmd = line.toUpperCase();
      if (cmd.startsWith("EHLO") || cmd.startsWith("HELO")) say("250 fake-smtp");
      else if (cmd.startsWith("MAIL FROM:")) say("250 ok");
      else if (cmd.startsWith("RCPT TO:")) {
        to = line.slice(8).trim().replace(/^<|>$/g, "");
        say("250 ok");
      } else if (cmd === "DATA") {
        inData = true;
        say("354 go ahead");
      } else if (cmd === "QUIT") {
        say("221 bye");
        sock.end();
      } else say("502 not implemented");
    }
  });
  sock.on("error", () => undefined);
}).listen(smtpPort, "127.0.0.1");

createHttp((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(req.url === "/messages" ? messages : { ok: true }));
}).listen(httpPort, "127.0.0.1");
