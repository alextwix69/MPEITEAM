export type ComponentStatus = 'up' | 'down';

export interface DependencyProbe {
  checkPostgres(): Promise<ComponentStatus>;
  checkRedis(): Promise<ComponentStatus>;
  checkObjectStorage(): Promise<ComponentStatus>;
  checkWorkerHeartbeat(): Promise<ComponentStatus>;
  close(): Promise<void>;
}

export interface ReadinessResponse {
  status: 'ready' | 'degraded' | 'unavailable';
  checkedAt: string;
  dependencies: {
    postgres: { status: ComponentStatus };
    redis: { status: ComponentStatus };
    objectStorage: { status: ComponentStatus };
    worker: { status: ComponentStatus };
  };
}
