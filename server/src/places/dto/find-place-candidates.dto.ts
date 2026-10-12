import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsNumber,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { DESTINATION_TAXONOMY_VERSION } from '../../classification/classification-response';
import { DESTINATION_CATEGORIES } from '../destination-category';
import type { DestinationCategory } from '../destination-category';

export class CurrentLocationDto {
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-180)
  @Max(180)
  longitude!: number;
}

export class ItemDto {
  @IsString()
  @Matches(/\S/, {
    message: 'item id must contain at least one non-whitespace character',
  })
  id!: string;

  @IsInt()
  @Min(1)
  revision!: number;

  @IsInt()
  @IsIn([DESTINATION_TAXONOMY_VERSION])
  taxonomyVersion!: typeof DESTINATION_TAXONOMY_VERSION;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(DESTINATION_CATEGORIES, { each: true })
  categories!: DestinationCategory[];
}

export class FindPlaceCandidatesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique((item: ItemDto | null | undefined) => item?.id)
  @ValidateNested({ each: true })
  @Type(() => ItemDto)
  items!: ItemDto[];

  @IsDefined()
  @ValidateNested()
  @Type(() => CurrentLocationDto)
  location!: CurrentLocationDto;
}
