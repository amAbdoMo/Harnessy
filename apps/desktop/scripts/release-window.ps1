# Owner-operated release window; background workers reuse the existing GitHub workflow.
param(
  [ValidateSet('Open', 'Inspect', 'Publish', 'Retry')][string]$Action = 'Open',
  [string]$Version = '',
  [switch]$Preview,
  [ValidateSet('Ready', 'Running', 'Failed', 'Published')][string]$PreviewState = 'Ready',
  [string]$PreviewOutputDirectory = ''
)
$ErrorActionPreference = 'Stop'
if ($Preview -and $Action -ne 'Open') { throw 'Preview cannot prepare or publish a release.' }
if ($PreviewOutputDirectory -and -not $Preview) { throw 'A preview export requires Preview mode.' }
function Find-ReleasePowerShell {
  $candidates = @((Get-Command pwsh.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
    "$env:ProgramFiles\PowerShell\7\pwsh.exe",
    "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe")
  $pwsh = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if (-not $pwsh) {
    Add-Type -AssemblyName PresentationFramework
    [Windows.MessageBox]::Show('PowerShell 7 is required to open the release window.', 'Harnessy releases') | Out-Null
    throw 'PowerShell 7 is unavailable.'
  }
  return $pwsh
}
if ($PSVersionTable.PSVersion.Major -lt 7 -and $Action -ne 'Open') {
  $pwsh = Find-ReleasePowerShell
  $arguments = @('-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-File', ('"' + $PSCommandPath + '"'), '-Action', $Action)
  if ($Version) { $arguments += @('-Version', $Version) }
  if ($Preview) { $arguments += @('-Preview', '-PreviewState', $PreviewState) }
  Start-Process -FilePath $pwsh -ArgumentList $arguments -WindowStyle Hidden | Out-Null
  exit
}
. (Join-Path $PSScriptRoot 'release-control.ps1')
$script:ReleaseWindowScript = $PSCommandPath
$script:ReleasePowerShell = Find-ReleasePowerShell
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$registration = Join-Path $env:LOCALAPPDATA 'CustomHarnessStaging/StagingDesktopLauncher/repository.txt'
if (-not (Test-Path -LiteralPath $registration) -or [IO.Path]::GetFullPath((Get-Content -LiteralPath $registration -Raw).Trim()) -ne $repositoryRoot) {
  Add-Type -AssemblyName PresentationFramework
  [Windows.MessageBox]::Show('Open the release launcher from your registered Harnessy staging folder. The main app folder is not used for release preparation.', 'Harnessy releases') | Out-Null
  exit 1
}
$context = New-ReleaseContext $repositoryRoot
if ($Action -ne 'Open') { Invoke-ReleaseWorker $context $Action $Version; exit }

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$windowMutex = [Threading.Mutex]::new($false, ($context.MutexName + '-Window' + $(if ($Preview) { "-$PreviewState" } else { '' })))
$ownsWindow = $false
try {
  try { $ownsWindow = $windowMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsWindow = $true }
  if (-not $ownsWindow) { exit }
  [xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
  Title="Harnessy Release Center" Width="690" Height="810" MinWidth="590" MinHeight="620" WindowStartupLocation="CenterScreen"
  Background="#081A24" FontFamily="Segoe UI" Foreground="#E4F4F5">
  <Window.Resources>
    <Style TargetType="Button"><Setter Property="Cursor" Value="Hand"/><Setter Property="Padding" Value="16,10"/>
      <Setter Property="Background" Value="#173541"/><Setter Property="Foreground" Value="#E4F4F5"/>
      <Setter Property="BorderBrush" Value="#31505A"/><Setter Property="FontSize" Value="13"/>
      <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="{x:Type Button}">
        <Border Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="7">
          <ContentPresenter Margin="{TemplateBinding Padding}" HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Border></ControlTemplate></Setter.Value></Setter>
      <Style.Triggers><Trigger Property="IsEnabled" Value="False"><Setter Property="Opacity" Value="0.45"/></Trigger>
        <Trigger Property="IsKeyboardFocused" Value="True"><Setter Property="BorderBrush" Value="#C1FBFF"/><Setter Property="BorderThickness" Value="2"/></Trigger>
      </Style.Triggers>
    </Style>
  </Window.Resources>
  <Grid Margin="30,26,30,24">
    <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
    <StackPanel Grid.Row="0">
      <TextBlock Text="HARNESSY  /  RELEASE CENTER" FontSize="11" FontWeight="SemiBold" Foreground="#9CE8ED" Margin="0,0,0,12"/>
      <TextBlock Name="Heading" Text="Your next update" FontSize="28" FontWeight="SemiBold"/>
      <TextBlock Name="Message" Text="Checking your changes and GitHub connection..." FontSize="14" Foreground="#A7C1C8" TextWrapping="Wrap" Margin="0,8,0,20"/>
    </StackPanel>
    <Border Grid.Row="1" Background="#102A35" BorderBrush="#294650" BorderThickness="1" CornerRadius="10" Padding="20,15" Margin="0,0,0,20">
      <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
        <StackPanel><TextBlock Text="UPDATE VERSION" FontSize="10" Foreground="#91B3BD"/><TextBlock Name="VersionLabel" Text="Checking..." FontSize="29" FontWeight="SemiBold" Margin="0,3,0,0"/>
          <TextBlock Name="SourceLabel" FontSize="11" Foreground="#91B3BD" Margin="0,4,0,0"/></StackPanel>
        <StackPanel Grid.Column="1" VerticalAlignment="Center"><TextBlock Text="LATEST PUBLISHED" FontSize="10" Foreground="#91B3BD"/>
          <TextBlock Name="LatestLabel" Text="..." FontSize="17" HorizontalAlignment="Right" Margin="0,6,0,0"/></StackPanel>
      </Grid>
    </Border>
    <ScrollViewer Grid.Row="2" VerticalScrollBarVisibility="Auto" Margin="0,0,0,16">
      <ItemsControl Name="Steps">
        <ItemsControl.ItemTemplate><DataTemplate>
          <Border BorderBrush="#26434D" BorderThickness="0,0,0,1" Padding="0,5">
            <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="38"/><ColumnDefinition Width="*"/><ColumnDefinition Width="80"/></Grid.ColumnDefinitions>
              <Border Width="28" Height="28" CornerRadius="14" Background="{Binding MarkerColor}" VerticalAlignment="Top">
                <TextBlock Text="{Binding Number}" Foreground="#E4F4F5" FontSize="12" FontWeight="SemiBold" VerticalAlignment="Center" HorizontalAlignment="Center"/>
              </Border>
              <StackPanel Grid.Column="1" Margin="6,0,10,0"><TextBlock Text="{Binding Label}" FontSize="14" FontWeight="SemiBold"/>
                <TextBlock Text="{Binding Detail}" Foreground="#91B3BD" FontSize="11" TextWrapping="Wrap" Margin="0,3,0,0"/></StackPanel>
              <TextBlock Grid.Column="2" Text="{Binding Badge}" Foreground="{Binding BadgeColor}" FontSize="10" FontWeight="SemiBold" HorizontalAlignment="Right" Margin="0,4,0,0"/>
            </Grid>
          </Border>
        </DataTemplate></ItemsControl.ItemTemplate>
      </ItemsControl>
    </ScrollViewer>
    <StackPanel Grid.Row="3">
      <Grid Margin="0,0,0,10"><TextBlock Name="ProgressLabel" Text="Checking your changes" FontSize="11" Foreground="#91B3BD"/>
        <TextBlock Name="ElapsedLabel" FontSize="11" Foreground="#91B3BD" HorizontalAlignment="Right"/></Grid>
      <ProgressBar Name="Progress" Minimum="0" Maximum="6" Height="4" Background="#173541" Foreground="#79D3DD" BorderThickness="0" Margin="0,0,0,18"/>
      <Button Name="Publish" Content="Checking..." IsEnabled="False" Height="48" Background="#9CE8ED" Foreground="#081A24" FontSize="16" FontWeight="SemiBold" BorderThickness="0" AutomationProperties.Name="Publish update"/>
      <TextBlock Name="Footnote" Text="Publishes to Check for Updates. Your app installs it when you choose." Foreground="#91B3BD" FontSize="11" HorizontalAlignment="Center" Margin="0,9,0,14"/>
      <StackPanel Orientation="Horizontal" HorizontalAlignment="Center">
        <Button Name="Refresh" Content="Refresh" Margin="0,0,8,0"/><Button Name="GitHub" Content="View on GitHub" Margin="0,0,8,0"/>
        <Button Name="Details" Content="Open details"/>
      </StackPanel>
    </StackPanel>
  </Grid>
</Window>
'@
  $window = [Windows.Markup.XamlReader]::Load([Xml.XmlNodeReader]::new($xaml))
  $window.MaxHeight = [Windows.SystemParameters]::WorkArea.Height - 40
  $controls = @{}
  foreach ($name in @('Heading','Message','VersionLabel','SourceLabel','LatestLabel','Steps','ProgressLabel','ElapsedLabel','Progress','Publish','Footnote','Refresh','GitHub','Details')) {
    $controls[$name] = $window.FindName($name)
  }
  $script:StartingReleaseWorker = $null

  function Start-WindowReleaseWorker {
    param([string]$WorkerAction, [string]$WorkerVersion = '')
    if ($Preview) { return }
    $arguments = @('-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-File', ('"' + $script:ReleaseWindowScript + '"'), '-Action', $WorkerAction)
    if ($WorkerVersion) { $arguments += @('-Version', $WorkerVersion) }
    $errorPath = Join-Path $context.Directory ('worker-' + [guid]::NewGuid().ToString() + '.log')
    return Start-Process -FilePath $script:ReleasePowerShell -ArgumentList $arguments -WorkingDirectory $context.Root -WindowStyle Hidden -RedirectStandardError $errorPath -PassThru
  }

  function Show-WindowReleaseState {
    param($State)
    $controls.Message.Text = $State.Message
    $controls.VersionLabel.Text = if ($State.Version) { 'v' + $State.Version } else { 'Checking...' }
    $controls.LatestLabel.Text = if ($State.LatestVersion) { 'v' + $State.LatestVersion } else { '...' }
    $controls.SourceLabel.Text = if ($State.SourceCommit.Length -ge 8) { 'Your committed changes  /  ' + $State.SourceCommit.Substring(0,8) } else { '' }
    $rows = for ($index = 0; $index -lt $State.Steps.Count; $index++) {
      $step = $State.Steps[$index]
      $color = switch ($step.Status) { 'succeeded' { '#74D6B7' } 'running' { '#9CE8ED' } 'failed' { '#FFAA92' } default { '#7495A0' } }
      $badge = switch ($step.Status) { 'succeeded' { 'DONE' } 'running' { 'IN PROGRESS' } 'failed' { 'STOPPED' } default { 'WAITING' } }
      [pscustomobject]@{ Number = [string]($index + 1); Label = $step.Label; Detail = $step.Detail; Badge = $badge; BadgeColor = $color;
        MarkerColor = $(if ($step.Status -eq 'running') { '#28616B' } elseif ($step.Status -eq 'succeeded') { '#214C45' } else { '#173541' }) }
    }
    $controls.Steps.ItemsSource = @($rows)
    $complete = @($State.Steps | Where-Object { $_.Status -eq 'succeeded' }).Count
    $controls.Progress.Value = $complete
    $controls.ProgressLabel.Text = "$complete of 6 steps complete"
    $controls.Heading.Text = switch ($State.Phase) { 'running' { 'Your update is on its way' } 'failed' { 'Your update needs attention' } 'published' { 'Your update is published' } default { 'Your next update' } }
    $controls.Publish.Content = if ($State.CanRetry) { 'Retry failed steps' } elseif ($State.Phase -eq 'checking') { 'Checking...' } elseif ($State.Phase -eq 'published') { 'Published v' + $State.Version } elseif ($State.Phase -eq 'running') { 'Publishing v' + $State.Version } elseif (-not $State.Version) { 'Not ready to publish' } else { 'Publish v' + $State.Version }
    $controls.Publish.IsEnabled = -not $Preview -and $null -eq $script:StartingReleaseWorker -and ($State.CanPublish -or $State.CanRetry)
    $controls.Refresh.IsEnabled = -not $Preview -and $null -eq $script:StartingReleaseWorker
    $controls.ElapsedLabel.Text = if ($State.StartedAt -and $State.Phase -eq 'running') { 'Elapsed ' + ([DateTime]::UtcNow - [DateTime]::Parse($State.StartedAt)).ToString('hh\:mm\:ss') } else { '' }
    $controls.Footnote.Text = if ($Preview) { 'PREVIEW - publishing is disabled.' } elseif ($State.Phase -eq 'running') { 'You can close this window. Reopen it to follow the same build.' } else { 'Publishes to Check for Updates. Your app installs it when you choose.' }
  }

  $controls.Publish.Add_Click({
    $saved = Read-ReleaseState $context
    if ($saved.CanRetry) { $script:StartingReleaseWorker = Start-WindowReleaseWorker 'Retry' }
    elseif ($saved.CanPublish) { $script:StartingReleaseWorker = Start-WindowReleaseWorker 'Publish' $saved.Version }
    $controls.Publish.IsEnabled = $false
  })
  $controls.Refresh.Add_Click({ $script:StartingReleaseWorker = Start-WindowReleaseWorker 'Inspect'; $controls.Publish.IsEnabled = $false; $controls.Refresh.IsEnabled = $false })
  $controls.GitHub.Add_Click({
    $saved = if ($Preview) { $null } else { Read-ReleaseState $context }
    $target = "https://github.com/$($context.Repository)/actions/workflows/$($context.Workflow)"
    if ($saved -and $saved.RunId) { $target = "https://github.com/$($context.Repository)/actions/runs/$([long]$saved.RunId)" }
    Start-Process $target | Out-Null
  })
  $controls.Details.Add_Click({ if (Test-Path -LiteralPath $context.LogPath) { Start-Process notepad.exe -ArgumentList ('"' + $context.LogPath + '"') | Out-Null } })

  if ($Preview) {
    $window.Title += ' (Preview ' + $PreviewState + ')'
    $previewModel = New-ReleaseState
    $previewModel.Version = '0.1.21'; $previewModel.LatestVersion = '0.1.20'; $previewModel.SourceCommit = '0123456789abcdef'
    $previewModel.Phase = $PreviewState.ToLowerInvariant()
    $previewModel.Message = 'Ready when you are. GitHub handles the build and publication.'
    if ($PreviewState -eq 'Ready') { $previewModel.Steps[0].Status = 'succeeded'; $previewModel.CanPublish = $true }
    if ($PreviewState -in @('Running', 'Failed')) {
      foreach ($step in $previewModel.Steps[0..3]) { $step.Status = 'succeeded'; $step.Detail = 'Complete' }
      $previewModel.Steps[4].Status = if ($PreviewState -eq 'Running') { 'running' } else { 'failed' }
      $previewModel.Steps[4].Detail = if ($PreviewState -eq 'Running') { 'Building your Windows update on GitHub...' } else { 'Build stopped. Open GitHub for the failed step, then retry.' }
      $previewModel.Message = $previewModel.Steps[4].Detail
      $previewModel.CanRetry = $PreviewState -eq 'Failed'
    }
    if ($PreviewState -eq 'Published') {
      $previewModel.LatestVersion = $previewModel.Version
      foreach ($step in $previewModel.Steps) { $step.Status = 'succeeded'; $step.Detail = 'Complete' }
      $previewModel.Message = 'v0.1.21 is published. Open Harnessy and choose Check for Updates.'
    }
    Show-WindowReleaseState $previewModel
    $controls.Refresh.IsEnabled = $false; $controls.GitHub.IsEnabled = $false; $controls.Details.IsEnabled = $false
    if ($PreviewOutputDirectory) {
      $window.Add_ContentRendered({
        $null = [IO.Directory]::CreateDirectory($PreviewOutputDirectory)
        $visual = $window
        $clientWidth = $window.Content.ActualWidth + $window.Content.Margin.Left + $window.Content.Margin.Right
        $clientHeight = $window.Content.ActualHeight + $window.Content.Margin.Top + $window.Content.Margin.Bottom
        $bitmap = [Windows.Media.Imaging.RenderTargetBitmap]::new([int]$clientWidth, [int]$clientHeight, 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
        $bitmap.Render($visual)
        $encoder = [Windows.Media.Imaging.PngBitmapEncoder]::new()
        $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
        $stream = [IO.File]::Create((Join-Path $PreviewOutputDirectory ("release-window-$PreviewState.png")))
        try { $encoder.Save($stream) } finally { $stream.Dispose() }
        @{ State = $PreviewState; Visible = $window.IsVisible; Steps = $controls.Steps.Items.Count; PublishEnabled = $controls.Publish.IsEnabled;
          Width = $visual.ActualWidth; Height = $visual.ActualHeight } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PreviewOutputDirectory ("release-window-$PreviewState.json"))
        $window.Close()
      })
    }
  } else {
    $script:StartingReleaseWorker = Start-WindowReleaseWorker 'Inspect'
    $timer = [Windows.Threading.DispatcherTimer]::new(); $timer.Interval = [TimeSpan]::FromSeconds(1)
    $timer.Add_Tick({
      if ($script:StartingReleaseWorker -and $script:StartingReleaseWorker.HasExited) { $script:StartingReleaseWorker.Dispose(); $script:StartingReleaseWorker = $null }
      try { $saved = Read-ReleaseState $context; if ($saved) { Show-WindowReleaseState $saved } }
      catch { $controls.Message.Text = 'Could not read release status. Click Refresh, or open details.' }
    })
    $timer.Start()
    $window.Add_Closed({ $timer.Stop(); if ($script:StartingReleaseWorker) { $script:StartingReleaseWorker.Dispose() } })
  }
  $null = $window.ShowDialog()
} finally {
  if ($ownsWindow) { $windowMutex.ReleaseMutex() }
  $windowMutex.Dispose()
}
