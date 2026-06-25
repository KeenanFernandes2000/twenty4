// authLegalCopy — bundled, in-app legal text rendered by (auth)/legal.tsx.
//
// There are NO /legal/* API routes; the reader renders this static copy. The text
// below is product-appropriate PLACEHOLDER copy (P1) — NOT lorem, but NOT a
// reviewed legal document. Replace with counsel-approved Terms & Privacy before
// any production / app-store submission.
//
// Each doc is an ordered list of sections (heading + body). The reader renders
// them as stacked headed paragraphs.

export interface LegalSection {
  heading: string;
  body: string;
}

export interface LegalDoc {
  title: string;
  /** Short "last updated" line shown under the title. */
  updated: string;
  sections: readonly LegalSection[];
}

// P1 PLACEHOLDER — replace with approved Terms of Service before production.
export const TERMS: LegalDoc = {
  title: 'Terms of Service',
  updated: 'Last updated June 2026',
  sections: [
    {
      heading: '1. Welcome to twenty4',
      body: 'twenty4 is a private space to share your day with the people who matter. By creating an account or using the app you agree to these terms. If you do not agree, please do not use twenty4.',
    },
    {
      heading: '2. Your account',
      body: 'You must provide an accurate phone number or email to sign in, and you are responsible for keeping access to that account secure. You agree not to impersonate others or create accounts for anyone but yourself. We may suspend accounts that violate these terms.',
    },
    {
      heading: '3. Your content',
      body: 'You own the photos, videos, and text you post. You grant twenty4 a limited license to store and display that content to the groups you share it with, solely to operate the service. We do not sell your content, and we do not use it for advertising.',
    },
    {
      heading: '4. Community expectations',
      body: 'Be kind. Do not post content that is illegal, abusive, or harmful, and do not share another person’s content or private information without their consent. Groups are private by design; respect the trust of the people you share with.',
    },
    {
      heading: '5. Service availability',
      body: 'We work to keep twenty4 reliable, but the service is provided “as is” without warranties. We may change, suspend, or discontinue features at any time. We are not liable for indirect or incidental damages to the fullest extent permitted by law.',
    },
    {
      heading: '6. Ending your use',
      body: 'You may stop using twenty4 and delete your account at any time. We may terminate or limit your access if you breach these terms. Some provisions, such as content licenses you have granted to your groups, survive where reasonably necessary.',
    },
    {
      heading: '7. Contact',
      body: 'Questions about these terms? Reach us at support@twenty4.app. We may update these terms from time to time; continued use after an update means you accept the revised terms.',
    },
  ],
};

// P1 PLACEHOLDER — replace with approved Privacy Policy before production.
export const PRIVACY: LegalDoc = {
  title: 'Privacy Policy',
  updated: 'Last updated June 2026',
  sections: [
    {
      heading: 'Our approach',
      body: 'twenty4 is built to be private by default. We collect the minimum we need to run the service and we never sell your personal data. This policy explains what we collect, why, and the choices you have.',
    },
    {
      heading: 'What we collect',
      body: 'To create your account we collect a phone number or email and a one-time verification code. You may add a display name, a username, and an optional profile photo. We collect the content you post and basic technical data (such as device type and crash logs) needed to keep the app working.',
    },
    {
      heading: 'How we use it',
      body: 'We use your information to authenticate you, deliver your posts to the groups you choose, keep the service secure, and fix problems. We do not use your private content to target advertising.',
    },
    {
      heading: 'Who can see your content',
      body: 'Content you post is visible only to members of the groups you share it with. We do not make your posts public. We share data with service providers (for example, secure cloud storage) strictly to operate twenty4, under confidentiality obligations.',
    },
    {
      heading: 'Data retention & deletion',
      body: 'We keep your data while your account is active. You can delete your account at any time, after which we remove your personal data within a reasonable period, except where we must retain limited records to meet legal obligations.',
    },
    {
      heading: 'Your choices & contact',
      body: 'You can review and update your profile in the app, and request deletion of your account. For privacy questions or requests, contact privacy@twenty4.app. We may update this policy; we will note the date of the latest revision above.',
    },
  ],
};
