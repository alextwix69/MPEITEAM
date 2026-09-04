import { Suspense } from 'react';
import { VerifyEmail } from '../../components/verify-email';

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<p className="p-8">Проверяем ссылку…</p>}>
      <VerifyEmail />
    </Suspense>
  );
}
