# Runs via ScriptsToProcess, i.e. in the CALLER's session state, before
# Limpet.psm1 loads. The built-in ls/rm/cp/mv/cat aliases are AllScope, so
# every scope that already exists holds its own copy of them; the module's
# Set-Alias -Scope Global replaces only the global table entry, and a script
# that imports Limpet keeps resolving its stale local copy (this is exactly
# how CI ran the test suite). From here, -Scope N addresses the caller's own
# scope chain, so walk it and overwrite every copy up to global.
$takeover = @{
    ls = 'NixLs'; cp = 'NixCp'; mv = 'NixMv'; rm = 'NixRm'; cat = 'NixCat'
}
for ($depth = 0; $depth -lt 64; $depth++) {
    try {
        foreach ($name in $takeover.Keys) {
            Set-Alias -Name $name -Value $takeover[$name] -Scope $depth -Force -Option AllScope -ErrorAction Stop
        }
    } catch {
        break   # ran past the outermost (global) scope
    }
}
