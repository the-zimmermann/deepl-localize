import cliProgress from "cli-progress";
import "colors";
import { Command } from "commander";
import * as deepl from "deepl-node";
import fs from "fs";
import { readMeta, writeMeta } from "./meta";
import outputDir from "./outputDir";
import retrieveBase from "./retrieveBase";
import { TranslationOptions } from "./translationOptions";
import { localizeFileSchema, validateBase } from "./validateBase";
import outputFilename from "./outputFilename";
import findContext from "../utils/findContext";

export default async function translate(this: Command) {
  const options = this.opts<TranslationOptions>();
  console.log(`Your settings:`);
  console.log(`\tBase: ${options.base}`);
  console.log(`\tOutput: ${outputDir(options.base ?? "", options.output)}`);
  console.log(`\tLocales: ${options.locales.join(", ")}`);
  if (options.withContext)
    console.log(`\tWith context: ${options.withContext}`);
  if (options.compiledI18n)
    console.log(`\tCompiled i18n: ${options.compiledI18n}`);
  console.log(
    `\tLocales informal: ${options.informalLocales.length === 0
      ? "none"
      : options.informalLocales.join(", ")
    }`
  );
  console.log("");

  if (options.base === undefined) throw new Error("No base path given.");

  if (options.locales.length === 0)
    throw new Error("No locales as targets given.");

  const base = retrieveBase(options.base);
  if (base === undefined) throw new Error("No valid base file given.");
  const baseData = validateBase(base);
  const { locale: localeString, translations } = baseData;
  const locale = new Intl.Locale(localeString);
  const apiKey = options.apiKey ?? process.env.DEEPL_API_KEY;
  if (apiKey === undefined) throw new Error("No api key given.");
  const translator = new deepl.Translator(apiKey);
  const sourceLanguages = await translator.getSourceLanguages();
  const targetLanguages = await translator.getTargetLanguages();
  let meta = readMeta(outputDir(options.base ?? "", options.output));

  const sourceLanguage =
    sourceLanguages.find(s => s.code === locale.baseName) ??
    sourceLanguages.find(s => s.code === locale.language);

  if (sourceLanguage === undefined)
    throw new Error("Could not find source language.");

  for (const targetLocaleString of options.locales) {
    try {
      const isInformal = options.informalLocales?.includes(targetLocaleString);
      const guessedTarget = targetLocaleString === 'en' ? 'en-US' : targetLocaleString.replace(/_/g, "-");
      const targetLocale = new Intl.Locale(guessedTarget);
      const targetLanguage =
        targetLanguages.find(s => s.code === targetLocale.baseName) ??
        targetLanguages.find(s => s.code === targetLocale.language);

      if (targetLanguage === undefined) {
        console.error(
          `Could not find target language for ${targetLocaleString.green
          }.\nSee supported target languages are ${targetLanguages.map(t => t.code).join(", ").yellow
          }`
        );
        continue;
      }

      const languageName = `${targetLanguage.name} ${isInformal ? "(informal)" : ""
        }`;

      console.log(`Start translation for ${languageName.green} (${targetLocaleString})`);

      const filename = outputFilename(targetLocaleString, {
        base: options.base,
        output: options.output,
      });

      if (fs.existsSync(filename) === false) {
        fs.writeFileSync(
          filename,
          JSON.stringify(
            { locale: targetLocaleString, translations: {} },
            null,
            2
          )
        );
      }

      const targetTranslationSafe = localizeFileSchema.safeParse(
        JSON.parse(fs.readFileSync(filename).toString())
      );

      if (targetTranslationSafe.success === false) {
        console.error(
          `Could not parse ${targetLocaleString}.json make sure there is no merge conflict inside the file. Will continue with next locale.`
            .red,
          targetTranslationSafe.error
        );
        continue;
      }

      let targetTranslation = targetTranslationSafe.data;
      const progress = new cliProgress.SingleBar(
        {},
        cliProgress.Presets.shades_classic
      );

      const filteredTranslations = Object.entries(translations).filter(
        ([key]) => {
          const translation = targetTranslation.translations[key];

          return (
            translation === undefined ||
            (typeof translation === "string" && translation.trim() === "")
          );
        }
      );

      if (filteredTranslations.length === 0) {
        console.log(
          `\tNo new translations for ${languageName} found. Will skip.\n`.green
        );
        continue;
      }

      progress.start(filteredTranslations.length, 0);
      for (let [key, sourceText] of filteredTranslations) {
        if (options.compiledI18n && Boolean(sourceText) === false) {
          sourceText = key;
        }
        progress.increment();
        const metaKey =
          targetLocale.language +
          (options.informalLocales?.includes(targetLocaleString)
            ? "-informal"
            : "");

        if (targetTranslation.translations[key]) continue;
        if (meta[metaKey]?.[JSON.stringify(sourceText)]) {
          targetTranslation.translations[key] =
            meta[metaKey][JSON.stringify(sourceText)];
          continue;
        }

        meta[metaKey] = meta[metaKey] ?? {};

        const object =
          typeof sourceText === "string" ? { flat: sourceText } : sourceText;

        for (const [plural, source] of Object.entries(object)) {
          const result = await translator.translateText(
            prepareVariables(source),
            sourceLanguage.code as deepl.SourceLanguageCode,
            targetLanguage.code as deepl.TargetLanguageCode,
            {
              formality:
                options.informalLocales?.includes(targetLocaleString) &&
                  targetLanguage.supportsFormality
                  ? "less"
                  : undefined,
              tagHandling: "xml",
              ignoreTags: ["x"],
              context: options.withContext ? await findContext(source) : undefined,
            }
          );
          if (plural === "flat") {
            targetTranslation.translations[key] = cleanVariables(result.text);
          } else {
            if (
              targetTranslation.translations[key] === undefined ||
              targetTranslation.translations[key] === ""
            ) {
              targetTranslation.translations[key] = {};
            }
            (targetTranslation.translations[key] as Record<string, string>)[
              plural.toString()
            ] = cleanVariables(result.text);
          }

          meta[metaKey][source] = cleanVariables(result.text);
        }
      }

      progress.stop();
      console.log("");

      fs.writeFileSync(filename, JSON.stringify(targetTranslation, null, 2));
    } catch (error) {
      console.error(targetLocaleString, error);
    }
  }

  writeMeta(meta, outputDir(options.base ?? "", options.output));
  process.exit(0);
}

function prepareVariables(string: string): string {
  return string.replace(/(\{\$.*?\})/g, "<x>$1</x>");
}

function cleanVariables(string: string): string {
  return string.replace(/<x>(.*?)<\/x>/g, "$1");
}
