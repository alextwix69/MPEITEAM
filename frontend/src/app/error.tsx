'use client';

import { useEffect } from 'react';
import { Button } from '../components/ui/button';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Ошибка отображения страницы', error);
  }, [error]);

  return (
    <div className="mx-auto max-w-xl px-5 py-24">
      <h1 className="text-3xl font-bold">Не удалось открыть страницу</h1>
      <p className="mt-3 text-slate-600">
        Попробуйте ещё раз. Если ошибка повторится, вернитесь позже.
      </p>
      <Button className="mt-6" onClick={reset}>
        Повторить
      </Button>
    </div>
  );
}
