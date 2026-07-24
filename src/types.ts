type Dependencies = Record<string, string>;

export type RegistryPackage = { repository?: string | { url?: string } };

export type PackageManifest = RegistryPackage &
  Partial<
    Record<
      "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies",
      Dependencies
    >
  >;

export type RepositoryRef = { cloneUrl: string; key: string; name: string };

export type RepositoryGroup = RepositoryRef & { packages: string[] };

export type IndexRepository = { directory: string; packages: string[]; root: string };
