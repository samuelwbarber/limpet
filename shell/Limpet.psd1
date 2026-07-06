@{
    RootModule        = 'Limpet.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'b1e3f6a2-9c4d-4f7a-8e21-3a5d6c7b8e90'
    Author            = 'samuelwbarber'
    Description       = 'limpet: common Linux/Unix commands inside PowerShell (flags translated to native cmdlets) plus xssh, a drop-in resilient ssh with Windows Hello key auth.'
    PowerShellVersion = '5.1'
    NestedModules     = @('limpet-hello.psm1')
    FunctionsToExport = @('NixLs', 'NixRm', 'NixCp', 'NixMv', 'NixCat', 'mkdir', 'touch', 'head', 'tail', 'grep', 'find', 'which', 'du', 'df', 'chmod', 'xssh', 'wput', 'peek', 'peak', 'reels', 'limpet',
                          'Enable-LimpetHello', 'Disable-LimpetHello', 'Get-LimpetHelloStatus', 'Get-LimpetHelloPassphrase', 'Test-LimpetHelloEnrolled', 'Protect-LimpetSecret', 'Unprotect-LimpetSecret', 'Get-LimpetAskpass', 'Get-LimpetKeyPath')
    CmdletsToExport   = @()
    AliasesToExport   = @('ls', 'rm', 'cp', 'mv', 'cat')
    VariablesToExport = @()
}
