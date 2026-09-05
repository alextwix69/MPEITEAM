import { Suspense } from 'react';
import { AuthForm } from '../../components/auth-form';
export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={<p>Загрузка…</p>}>
      <AuthForm mode="forgot" />
    </Suspense>
  );
}
