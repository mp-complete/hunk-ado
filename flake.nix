{
  inputs = {
    utils.url = "github:numtide/flake-utils";
  };
  description = "Hunk with a read-only Azure DevOps pull request extension";

  outputs =
    { nixpkgs, utils, ... }:
    utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        inherit (pkgs) lib;

        # No node_modules, credentials, checkout state, or build step in the extension.
        extensionSource = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./package.json
            ./src
            ./README.md
          ];
        };
        extension = pkgs.runCommand "hunk-ado-extension" { } ''
          mkdir -p "$out/share/hunk/extensions"
          cp -r ${extensionSource} "$out/share/hunk/extensions/hunk-ado"
        '';
        extensionPath = "${extension}/share/hunk/extensions/hunk-ado";
        upstreamHunk =
          assert lib.versionAtLeast pkgs.hunk.version "0.25.0";
          pkgs.hunk;

        # Packaged app always loads the immutable extension from this flake revision.
        hunkAdo = pkgs.writeShellApplication {
          name = "hunk";
          runtimeInputs = [
            pkgs.git
            pkgs.azure-cli
          ];
          text = ''
            exec ${lib.getExe upstreamHunk} --extension ${extensionPath} "$@"
          '';
        };

        # The shell uses the live checkout; nix run/build remain reproducible snapshots.
        devHunk = pkgs.writeShellApplication {
          name = "hunk";
          runtimeInputs = [
            pkgs.git
            pkgs.azure-cli
          ];
          text = ''
            exec ${lib.getExe upstreamHunk} --extension "''${HUNK_ADO_EXTENSION_PATH:-${extensionPath}}" "$@"
          '';
        };
        devShell = pkgs.mkShell {
          packages = [
            devHunk
            pkgs.nodejs_24
            pkgs.git
            pkgs.azure-cli
          ];
          shellHook = ''
            if [[ -f "$PWD/src/index.ts" && -f "$PWD/package.json" ]] &&
              ${lib.getExe pkgs.nodejs_24} -e 'process.exit(require("./package.json").name === "hunk-ado" ? 0 : 1)' >/dev/null 2>&1; then
              export HUNK_ADO_EXTENSION_PATH="$PWD"
            else
              export HUNK_ADO_EXTENSION_PATH="${extensionPath}"
            fi
          '';
        };
        app = {
          type = "app";
          program = lib.getExe hunkAdo;
          meta.description = "Hunk with the Azure DevOps PR extension preloaded";
        };
      in
      {
        packages = {
          default = hunkAdo;
          hunk-ado = hunkAdo;
          inherit extension;
        };
        apps = {
          default = app;
          hunk-ado = app;
        };
        devShells.default = devShell;
        inherit devShell; # Keep the existing direnv/legacy devShell entry point.
        formatter = pkgs.nixfmt;
        checks.extension-load =
          pkgs.runCommand "hunk-ado-extension-load"
            {
              nativeBuildInputs = [ hunkAdo ];
            }
            ''
              export HOME="$TMPDIR/home"
              mkdir -p "$HOME"
              hunk ado --help > help.txt
              grep -F 'hunk ado pr' help.txt
              grep -F 'Notes stay local.' help.txt
              touch "$out"
            '';
      }
    );
}
