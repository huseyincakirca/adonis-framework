/*
 * @adonisjs/core
 *
 * (c) Harminder Virk <virk@adonisjs.com>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
*/

import { join } from 'path'
import findPkg from 'find-package-json'
import { esmRequire } from '@poppinss/utils'
import { Ioc, Registrar } from '@adonisjs/fold'
import { LoggerContract } from '@ioc:Adonis/Core/Logger'
import { ApplicationContract } from '@ioc:Adonis/Core/Application'
import { Application } from '@adonisjs/application/build/standalone'

import { optionalResolveAndRequire, isMissingModuleError } from '../../utils'

/**
 * Exposes the API to bootstrap the application by registering-booting the
 * providers, require preloads and so on.
 */
export class Bootstrapper {
  /**
   * Reference to the application
   */
  public application: ApplicationContract

  /**
   * Reference to registrar
   */
  private registrar: Registrar

  /**
   * Reference to the logger, will be set once providers
   * have been registered.
   */
  private logger?: LoggerContract

  /**
   * Providers that has ready hook function
   */
  private providersWithReadyHook: any[] = []

  /**
   * Providers that has shutdown hook function
   */
  private providersWithShutdownHook: any[] = []

  constructor (
    private appRoot: string,
    public touchContainerBindings: boolean = false,
  ) {
  }

  /**
   * Setup the Ioc container globals and the application. This lays
   * off the ground for not having `global.use` runtime errors.
   */
  public setup (): ApplicationContract {
    const ioc = new Ioc()

    /**
     * Adding IoC container resolver methods to the globals.
     */
    global[Symbol.for('ioc.use')] = ioc.use.bind(ioc)
    global[Symbol.for('ioc.make')] = ioc.make.bind(ioc)
    global[Symbol.for('ioc.call')] = ioc.call.bind(ioc)

    const adonisCorePkgFile = findPkg(join(__dirname, '..', '..')).next().value
    const appPkgFile = findPkg(this.appRoot).next().value

    const pkgFile = {
      name: appPkgFile ? appPkgFile.name : 'adonis',
      version: appPkgFile ? appPkgFile.version : '0.0.0',
      adonisVersion: adonisCorePkgFile!.version,
    }

    /**
     * Loading `.adonisrc.json` file with custom error handling when
     * the file is missing
     */
    let rcContents = {}
    try {
      rcContents = esmRequire(join(this.appRoot, '.adonisrc.json'))
    } catch (error) {
      if (isMissingModuleError(error)) {
        throw new Error('Make sure the project root has ".adonisrc.json"')
      }
      throw error
    }

    /**
     * Setting up the application and binding it to the container as well. This makes
     * it's way to the container even before the providers starts registering
     * themselves.
     */
    this.application = new Application(this.appRoot, ioc, rcContents, pkgFile)
    this.registrar = new Registrar(ioc, this.appRoot)

    ioc.singleton('Adonis/Core/Application', () => this.application)
    return this.application
  }

  /**
   * Register the providers and their aliases to the IoC container.
   */
  public registerProviders (includeAce: boolean) {
    const providers = includeAce
      ? this.application.rcFile.providers.concat(this.application.rcFile.aceProviders)
      : this.application.rcFile.providers

    const providersList = providers.filter((provider) => !!provider)
    const providersRefs = this.registrar.useProviders(providersList).register()

    /**
     * Storing a reference of providers that has ready and exit hooks
     */
    providersRefs.forEach((provider) => {
      if (typeof (provider.ready) === 'function') {
        this.providersWithReadyHook.push(provider)
      }

      if (typeof (provider.shutdown) === 'function') {
        this.providersWithShutdownHook.push(provider)
      }
    })

    if (this.touchContainerBindings) {
      this.logger = this.application.container.use('Adonis/Core/Logger')
    }
    return providersRefs
  }

  /**
   * Registers autoloading directories
   */
  public registerAliases () {
    this.application.aliasesMap.forEach((toPath, alias) => {
      if (this.logger) {
        this.logger.trace('registering %s under %s alias', toPath, alias)
      }
      this.application.container.autoload(join(this.application.appRoot, toPath), alias)
    })
  }

  /**
   * Requires preloads
   */
  public registerPreloads () {
    this.application.preloads
      .filter((node) => {
        if (!node.environment || this.application.environment === 'unknown') {
          return true
        }

        return node.environment.indexOf(this.application.environment) > -1
      })
      .forEach((node) => {
        if (this.logger) {
          this.logger.trace('preloading %s file', node.file)
        }
        optionalResolveAndRequire(node.file, this.application.appRoot, node.optional)
      })
  }

  /**
   * Executes the ready hooks on the providers
   */
  public async executeReadyHooks () {
    if (this.logger) {
      this.logger!.trace('executing ready hooks')
    }
    await Promise.all(this.providersWithReadyHook.map((provider) => provider.ready()))
    this.providersWithReadyHook = []
  }

  /**
   * Executes the ready hooks on the providers
   */
  public async executeShutdownHooks () {
    if (this.logger) {
      this.logger!.trace('executing shutdown hooks')
    }
    await Promise.all(this.providersWithShutdownHook.map((provider) => provider.shutdown()))
    this.providersWithShutdownHook = []
  }

  /**
   * Boot providers by invoking `boot` method on them
   */
  public async bootProviders () {
    if (this.logger) {
      this.logger!.trace('booting providers')
    }
    await this.registrar.boot()
  }
}
