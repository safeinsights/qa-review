import { listSuites } from '@/engine/suite-registry'
import { ENVIRONMENTS } from '../../../config/environments'

// Print the available suites + stable env names as JSON, for the GUI dropdowns.
export async function listCommand(): Promise<void> {
    const suites = await listSuites()
    const envs = ENVIRONMENTS.map((e) => e.name)
    process.stdout.write(JSON.stringify({ suites, envs }) + '\n')
}
