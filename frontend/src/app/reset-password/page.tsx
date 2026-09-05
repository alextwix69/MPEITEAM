import { Suspense } from 'react';
import { AuthForm } from '../../components/auth-form';
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<p>Загрузка…</p>}>
      <AuthForm mode="reset" />
    </Suspense>
  );
}
