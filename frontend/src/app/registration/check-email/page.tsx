import { ResendVerificationForm } from '../../../components/resend-verification-form';

export default function CheckEmailPage() {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-xl items-center px-5 py-10">
      <section className="w-full rounded-2xl border border-[var(--border)] bg-white p-6 sm:p-10">
        <h1 className="text-3xl font-bold">Проверьте почту</h1>
        <p className="mt-4 text-slate-700">
          Мы поставили сервисное письмо в очередь. Перейдите по ссылке из письма, чтобы подтвердить
          адрес. Доставка может занять несколько минут.
        </p>
        <ResendVerificationForm />
      </section>
    </div>
  );
}
