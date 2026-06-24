// Email service — dual transport (nodemailer → Mailpit in dev, SES in prod,
// switched by NODE_ENV), Handlebars templates compiled once at startup, with a
// stripHtml plain-text fallback. The single call-site for transactional email so
// dropping in SES/SendGrid later needs zero changes at the OTP path.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SES } from "@aws-sdk/client-ses";
import Handlebars from "handlebars";
import nodemailer, { type Transporter } from "nodemailer";

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");

export interface EmailServiceOptions {
  nodeEnv: string;
  mailpitHost?: string;
  mailpitPort?: number;
  sesFromEmail?: string;
  awsRegion?: string;
}

export interface OtpEmailVars {
  code: string;
  ttlMinutes: number;
}

// Compile a Handlebars template from templates/<name>.hbs once.
function compileTemplate(name: string): Handlebars.TemplateDelegate {
  const src = readFileSync(join(TEMPLATES_DIR, `${name}.hbs`), "utf8");
  return Handlebars.compile(src);
}

// Crude HTML → text fallback for the plain-text MIME part.
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class EmailService {
  private readonly isProd: boolean;
  private readonly from: string;
  private readonly transporter?: Transporter;
  private readonly ses?: SES;
  private readonly otpTemplate: Handlebars.TemplateDelegate;

  constructor(private readonly opts: EmailServiceOptions) {
    this.isProd = opts.nodeEnv === "production";
    this.otpTemplate = compileTemplate("otp");

    if (this.isProd) {
      // SES transport. Credentials are taken from the standard AWS env chain.
      this.from = opts.sesFromEmail ?? "no-reply@twenty4.app";
      this.ses = new SES({ region: opts.awsRegion ?? "us-east-1" });
    } else {
      // Mailpit (dev): plain SMTP, no auth, no TLS.
      this.from = "no-reply@twenty4.local";
      this.transporter = nodemailer.createTransport({
        host: opts.mailpitHost ?? "localhost",
        port: opts.mailpitPort ?? 1025,
        secure: false,
        ignoreTLS: true,
      });
    }
  }

  // Low-level send. Awaited; throws on transport failure so callers can surface it.
  private async send(to: string, subject: string, html: string): Promise<void> {
    const text = stripHtml(html);
    if (this.isProd && this.ses) {
      await this.ses.sendEmail({
        Source: this.from,
        Destination: { ToAddresses: [to] },
        Message: {
          Subject: { Data: subject },
          Body: { Html: { Data: html }, Text: { Data: text } },
        },
      });
      return;
    }
    if (this.transporter) {
      await this.transporter.sendMail({ from: this.from, to, subject, html, text });
      return;
    }
    throw new Error("email transport not configured");
  }

  // Send a branded OTP email. Awaited + throws on failure (NOT fire-and-forget).
  async sendOtpEmail(email: string, vars: OtpEmailVars): Promise<void> {
    const html = this.otpTemplate(vars);
    await this.send(email, `Your twenty4 code: ${vars.code}`, html);
  }
}

export function createEmailService(opts: EmailServiceOptions): EmailService {
  return new EmailService(opts);
}
