import { RegistrationForm } from '../../components/registration-form';

export const dynamic = 'force-dynamic';

export default function RegistrationPage() {
  return (
    <RegistrationForm
      documentVersions={{
        age_18: process.env.CONSENT_VERSION_AGE_18 ?? 'local-v1',
        user_terms: process.env.CONSENT_VERSION_USER_TERMS ?? 'local-v1',
        personal_data: process.env.CONSENT_VERSION_PERSONAL_DATA ?? 'local-v1',
        public_profile_distribution: process.env.CONSENT_VERSION_PUBLIC_PROFILE ?? 'local-v1',
      }}
    />
  );
}
