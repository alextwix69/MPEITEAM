'use client';

import { useEffect, useState } from 'react';
import { apiClient } from '../lib/api/client';

export function ApprovedImage({ mediaId, alt }: { mediaId: string; alt: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let active = true;
    void apiClient
      .GET('/media/{mediaId}/download-url', {
        params: { path: { mediaId } },
        cache: 'no-store',
      })
      .then((result) => {
        if (active && result.data) setUrl(result.data.url);
      });
    return () => {
      active = false;
    };
  }, [mediaId]);
  if (!url) return null;
  // The URL is short-lived and generated only after server-side publication authorization.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt} className="max-h-64 rounded-xl object-cover" />;
}
