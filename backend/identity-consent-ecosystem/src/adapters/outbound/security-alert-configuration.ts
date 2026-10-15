type Environment = 'local' | 'dev' | 'staging' | 'prod';
export type SecurityEmailConfiguration = { environment: Environment; from: string; to: string };

export function securityEmailConfiguration(value: unknown, environment: string): SecurityEmailConfiguration | null {
  if (value === undefined || value === '') return null;
  try {
    if (typeof value !== 'string' || value.length > 1024) throw new Error();
    const config: unknown = JSON.parse(value);
    if (!config || typeof config !== 'object' || Array.isArray(config)
      || Object.keys(config).sort().join(',') !== 'environment,from,to'
      || !('environment' in config) || config.environment !== environment
      || !['local', 'dev', 'staging', 'prod'].includes(environment)
      || !('from' in config) || typeof config.from !== 'string'
      || !('to' in config) || typeof config.to !== 'string') throw new Error();
    return { environment: environment as Environment, from: config.from, to: config.to };
  } catch { throw new Error('invalid_security_alert_email_configuration'); }
}
