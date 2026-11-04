export interface SecretSource {
  read(name: string): string | undefined;
}
