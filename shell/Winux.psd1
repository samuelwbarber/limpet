@{
    RootModule        = 'Winux.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'b1e3f6a2-9c4d-4f7a-8e21-3a5d6c7b8e90'
    Author            = 'samuelwbarber'
    Description       = 'winux: common Linux/Unix commands inside PowerShell (flags translated to native cmdlets) plus xssh, a drop-in resilient ssh.'
    PowerShellVersion = '5.1'
    FunctionsToExport = @('NixLs', 'NixRm', 'NixCp', 'NixMv', 'NixCat', 'mkdir', 'touch', 'head', 'tail', 'grep', 'find', 'which', 'du', 'df', 'chmod', 'xssh', 'wput', 'peek', 'peak', 'reels', 'winux')
    CmdletsToExport   = @()
    AliasesToExport   = @('ls', 'rm', 'cp', 'mv', 'cat')
    VariablesToExport = @()
}
