export interface SignupOtpEmailContent {
  subject: string;
  html: string;
  text: string;
}

export function buildSignupOtpEmail(params: { name?: string; otp: string }): SignupOtpEmailContent {
  const greeting = params.name ? `Hi ${params.name},` : "Hi,";
  return {
    subject: `${params.otp} is your Nexus verification code`,
    text: `${greeting}\n\nYour verification code is ${params.otp}. It expires in 10 minutes.\n\nIf you didn't request this, you can safely ignore this email.`,
    html: `<p>${greeting}</p><p>Your verification code is <strong style="font-size:20px;letter-spacing:2px">${params.otp}</strong>. It expires in 10 minutes.</p><p>If you didn't request this, you can safely ignore this email.</p>`,
  };
}
