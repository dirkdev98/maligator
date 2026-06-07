#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "array_object.h"
#include "bound_function_object.h"
#include "function_object.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "object.h"
#include "object_ops.h"
#include "property_iter.h"
#include "property_store.h"
#include "table.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

// === GENERATED from tests/local/tmp2.js via `node src/index.ts tests/local/tmp2.js` ===
static const c16 mal_string_0_code_units[] = { 0 };
static const c16 mal_string_1_code_units[] = { 100, 101, 102, 105, 110, 101, 80, 114, 111, 112, 101, 114, 116, 121 };
static const c16 mal_string_2_code_units[] = { 120 };
static const c16 mal_string_3_code_units[] = { 118, 97, 108, 117, 101 };
static const c16 mal_string_4_code_units[] = { 119, 114, 105, 116, 97, 98, 108, 101 };
static const c16 mal_string_5_code_units[] = { 101, 110, 117, 109, 101, 114, 97, 98, 108, 101 };
static const c16 mal_string_6_code_units[] = { 109, 97, 112 };
static const c16 mal_string_7_code_units[] = { 107, 101, 121, 115 };
static const c16 mal_string_8_code_units[] = { 114, 101, 100, 117, 99, 101 };
static const c16 mal_string_9_code_units[] = { 97, 116, 116, 101, 109, 112, 116 };
static const c16 mal_string_10_code_units[] = { 98, 111, 111, 109 };
static const c16 mal_string_11_code_units[] = { 109, 101, 115, 115, 97, 103, 101 };
static const c16 mal_string_12_code_units[] = { 110, 97, 109, 101 };
static const c16 mal_string_13_code_units[] = { 87, 114, 97, 112, 112, 101, 114 };
static const c16 mal_string_14_code_units[] = { 112, 114, 111, 116, 111, 116, 121, 112, 101 };
static const c16 mal_string_15_code_units[] = { 107, 105, 110, 100 };
static const c16 mal_string_16_code_units[] = { 111, 111, 112, 115 };
static const c16 mal_string_17_code_units[] = { 111, 117, 116, 32, 111, 102, 32, 114, 97, 110, 103, 101 };
static const c16 mal_string_18_code_units[] = { 112, 97, 105, 114, 83, 117, 109 };
static const c16 mal_string_19_code_units[] = { 99, 97, 108, 108 };
static const c16 mal_string_20_code_units[] = { 97, 112, 112, 108, 121 };
static const c16 mal_string_21_code_units[] = { 98, 105, 110, 100 };
static const c16 mal_string_22_code_units[] = { 108, 101, 110, 103, 116, 104 };
static const c16 mal_string_23_code_units[] = { 84, 121, 112, 101, 69, 114, 114, 111, 114 };
static const c16 mal_string_24_code_units[] = { 69, 114, 114, 111, 114 };
static const c16 mal_string_25_code_units[] = { 82, 97, 110, 103, 101, 69, 114, 114, 111, 114 };
static const c16 mal_string_26_code_units[] = { 32, 32, 72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100, 32, 32 };
static const c16 mal_string_27_code_units[] = { 116, 114, 105, 109 };
static const c16 mal_string_28_code_units[] = { 116, 111, 85, 112, 112, 101, 114, 67, 97, 115, 101 };
static const c16 mal_string_29_code_units[] = { 97, 44, 98, 44, 99 };
static const c16 mal_string_30_code_units[] = { 115, 112, 108, 105, 116 };
static const c16 mal_string_31_code_units[] = { 44 };
static const c16 mal_string_32_code_units[] = { 52, 50 };
static const c16 mal_string_33_code_units[] = { 105, 115, 73, 110, 116, 101, 103, 101, 114 };
static const c16 mal_string_34_code_units[] = { 115, 116, 114, 105, 110, 103 };
static const c16 mal_string_35_code_units[] = { 102, 97, 108, 108, 98, 97, 99, 107 };
static const c16 mal_string_36_code_units[] = { 112, 114, 101, 115, 101, 110, 116 };
static const c16 mal_string_37_code_units[] = { 103, 111, 110, 101 };
static const c16 mal_string_38_code_units[] = { 109, 105, 115, 115, 105, 110, 103 };
static const c16 mal_string_39_code_units[] = { 116, 111, 83, 116, 114, 105, 110, 103 };
static const c16 mal_string_40_code_units[] = { 117, 110, 100, 101, 102, 105, 110, 101, 100 };
static const c16 mal_string_41_code_units[] = { 111, 98, 106, 101, 99, 116 };
static const c16 mal_string_42_code_units[] = { 98, 111, 111, 108, 101, 97, 110 };
static const c16 mal_string_43_code_units[] = { 110, 117, 109, 98, 101, 114 };
static const c16 mal_string_44_code_units[] = { 102, 117, 110, 99, 116, 105, 111, 110 };
static const c16 mal_string_45_code_units[] = { 95, 118 };
static const c16 mal_string_46_code_units[] = { 118 };
static const c16 mal_string_47_code_units[] = { 103, 101, 116, 32, 118 };
static const c16 mal_string_48_code_units[] = { 115, 101, 116, 32, 118 };
static const c16 mal_string_49_code_units[] = { 116, 119, 105, 99, 101 };
static const c16 mal_string_50_code_units[] = { 99, 111, 109, 112, 117, 116, 101, 100 };
static const c16 mal_string_51_code_units[] = { 103, 101, 116 };
static const c16 mal_string_52_code_units[] = { 99, 111, 110, 102, 105, 103, 117, 114, 97, 98, 108, 101 };
static const c16 mal_string_53_code_units[] = { 112, 114, 111, 112 };
static const c16 mal_string_54_code_units[] = { 114, 111 };
static const c16 mal_string_55_code_units[] = { 72, 111, 108, 100, 101, 114 };
static const c16 mal_string_56_code_units[] = { 116, 97, 103 };
static const c16 mal_string_57_code_units[] = { 103, 101, 116, 32, 116, 97, 103 };
static const c16 mal_string_58_code_units[] = { 110, 101, 118, 101, 114, 68, 101, 99, 108, 97, 114, 101, 100, 65, 110, 121, 119, 104, 101, 114, 101 };
static const c16 mal_string_59_code_units[] = { 82, 101, 102, 101, 114, 101, 110, 99, 101, 69, 114, 114, 111, 114 };
static const c16 mal_string_60_code_units[] = { 110, 101, 118, 101, 114, 68, 101, 99, 108, 97, 114, 101, 100, 65, 110, 121, 119, 104, 101, 114, 101, 32, 105, 115, 32, 110, 111, 116, 32, 100, 101, 102, 105, 110, 101, 100 };
static const c16 mal_string_61_code_units[] = { 115, 116, 114, 105, 110, 103, 105, 102, 121 };
static const c16 mal_string_62_code_units[] = { 106 };
static const c16 mal_string_63_code_units[] = { 103, 101, 116, 32, 106 };
static const c16 mal_string_64_code_units[] = { 99, 111, 117, 110, 116, 101, 114 };
static const c16 mal_string_65_code_units[] = { 97, 100, 100, 101, 114 };
static const c16 mal_string_66_code_units[] = { 109, 97, 107, 101, 67, 101, 108, 108 };
static const c16 mal_string_67_code_units[] = { 103, 101, 116, 32, 118, 97, 108, 117, 101 };
static const c16 mal_string_68_code_units[] = { 115, 101, 116, 32, 118, 97, 108, 117, 101 };
static const c16 mal_string_69_code_units[] = { 83, 104, 97, 112, 101 };
static const c16 mal_string_70_code_units[] = { 100, 101, 115, 99, 114, 105, 98, 101 };
static const c16 mal_string_71_code_units[] = { 58 };
static const c16 mal_string_72_code_units[] = { 115, 105, 100, 101, 115 };
static const c16 mal_string_73_code_units[] = { 102, 97, 109, 105, 108, 121 };
static const c16 mal_string_74_code_units[] = { 115, 104, 97, 112, 101 };
static const c16 mal_string_75_code_units[] = { 83, 113, 117, 97, 114, 101 };
static const c16 mal_string_76_code_units[] = { 115, 113, 117, 97, 114, 101 };
static const c16 mal_string_77_code_units[] = { 115, 105, 122, 101 };
static const c16 mal_string_78_code_units[] = { 99, 111, 110, 115, 116, 114, 117, 99, 116, 111, 114 };
static const c16 mal_string_79_code_units[] = { 97, 114, 101, 97 };
static const c16 mal_string_80_code_units[] = { 64 };
static const c16 mal_string_81_code_units[] = { 115, 113, 117, 97, 114, 101, 58, 52, 64, 51 };
static const c16 mal_string_82_code_units[] = { 115 };
static const c16 mal_string_83_code_units[] = { 109, 97, 120 };
static const c16 mal_string_84_code_units[] = { 109, 105, 110 };
static const c16 mal_string_85_code_units[] = { 97, 98, 115 };
static const c16 mal_string_86_code_units[] = { 102, 108, 111, 111, 114 };
static const c16 mal_string_87_code_units[] = { 114, 111, 117, 110, 100 };
static const c16 mal_string_88_code_units[] = { 116, 114, 117, 110, 99 };
static const c16 mal_string_89_code_units[] = { 112, 111, 119 };
static const c16 mal_string_90_code_units[] = { 97 };
static const c16 mal_string_91_code_units[] = { 98 };
static const c16 mal_string_92_code_units[] = { 112, 97, 114, 115, 101 };
static const c16 mal_string_93_code_units[] = { 77, 97, 116, 104 };
static const c16 mal_string_94_code_units[] = { 108, 111, 103 };
static const c16 mal_string_95_code_units[] = { 109, 97, 108, 105, 103, 97, 116, 111, 114, 32, 102, 105, 120, 116, 117, 114, 101, 32, 114, 101, 115, 117, 108, 116, 32, 105, 110, 99, 111, 109, 105, 110, 103, 58 };
static const c16 mal_string_96_code_units[] = { 99 };
static const c16 mal_string_97_code_units[] = { 100 };
static const c16 mal_string_98_code_units[] = { 110, 101, 115, 116, 101, 100 };
static const c16 mal_string_99_code_units[] = { 100, 101, 101, 112 };
static const c16 mal_string_100_code_units[] = { 100, 112, 97, 114, 97, 109, 115 };
static const c16 mal_string_101_code_units[] = { 121 };
static const c16 mal_string_102_code_units[] = { 100, 114, 101, 115, 116, 79, 110, 108, 121 };
static const c16 mal_string_103_code_units[] = { 100, 99, 104, 97, 105, 110 };
static const c16 mal_string_104_code_units[] = { 100, 108, 97, 122, 121, 68, 101, 102, 97, 117, 108, 116 };
static const c16 mal_string_105_code_units[] = { 102 };
static const c16 mal_string_106_code_units[] = { 100, 97, 114, 103, 67, 111, 117, 110, 116 };
static const c16 mal_string_107_code_units[] = { 100, 65, 114, 114, 111, 119 };
static const c16 mal_string_108_code_units[] = { 100, 108, 101, 110, 66 };
static const c16 mal_string_109_code_units[] = { 100, 108, 101, 110, 67 };
static const c16 mal_string_110_code_units[] = { 100, 108, 101, 110, 68 };
static const c16 mal_string_111_code_units[] = { 100, 97, 120 };
static const c16 mal_string_112_code_units[] = { 108, 101, 102, 116 };
static const c16 mal_string_113_code_units[] = { 114, 105, 103, 104, 116 };
static const c16 mal_string_114_code_units[] = { 97, 98, 99, 100 };
static const c16 mal_string_115_code_units[] = { 120, 121 };
static const c16 mal_string_116_code_units[] = { 100, 98, 111, 111, 109 };
static const c16 mal_string_117_code_units[] = { 84, 121, 112, 101, 69, 114, 114, 111, 114, 58, 100, 98, 111, 111, 109 };
static const c16 mal_string_118_code_units[] = { 110, 97, 109, 101, 100, 65, 114, 114, 111, 119 };
static const c16 mal_string_119_code_units[] = { 110, 97, 109, 101, 100, 70, 110, 69, 120, 112, 114 };
static const c16 mal_string_120_code_units[] = { 110, 97, 109, 101, 100, 67, 108, 97, 115, 115 };
static const c16 mal_string_121_code_units[] = { 100, 102, 108, 116 };
static const c16 mal_string_122_code_units[] = { 115, 101, 116, 80, 114, 111, 116, 111, 116, 121, 112, 101, 79, 102 };
static const c16 mal_string_123_code_units[] = { 112, 114, 101, 118, 101, 110, 116, 69, 120, 116, 101, 110, 115, 105, 111, 110, 115 };
static const c16 mal_string_124_code_units[] = { 123, 32, 34, 95, 95, 112, 114, 111, 116, 111, 95, 95, 34, 58, 32, 55, 32, 125 };
static const c16 mal_string_125_code_units[] = { 115, 112, 108, 105, 99, 101 };
static const c16 mal_string_126_code_units[] = { 103, 101, 116, 80, 114, 111, 116, 111, 116, 121, 112, 101, 79, 102 };
static const c16 mal_string_127_code_units[] = { 95, 95, 112, 114, 111, 116, 111, 95, 95 };
static const c16 mal_string_128_code_units[] = { 104, 97, 115, 79, 119, 110, 80, 114, 111, 112, 101, 114, 116, 121 };
static const c16 mal_string_129_code_units[] = { 111, 110, 101 };
static const c16 mal_string_130_code_units[] = { 97, 108, 112, 104, 97 };
static const c16 mal_string_131_code_units[] = { 115, 101, 116 };
static const c16 mal_string_132_code_units[] = { 110, 97, 110 };
static const c16 mal_string_133_code_units[] = { 122, 101, 114, 111 };
static const c16 mal_string_134_code_units[] = { 116, 119, 111 };
static const c16 mal_string_135_code_units[] = { 100, 101, 108, 101, 116, 101 };
static const c16 mal_string_136_code_units[] = { 104, 97, 115 };
static const c16 mal_string_137_code_units[] = { 97, 108, 112, 104, 97, 50 };
static const c16 mal_string_138_code_units[] = { 102, 111, 114, 69, 97, 99, 104 };
static const c16 mal_string_139_code_units[] = { 112, 117, 115, 104 };
static const c16 mal_string_140_code_units[] = { 106, 111, 105, 110 };
static const c16 mal_string_141_code_units[] = { 97, 44, 78, 97, 78, 44, 48, 44, 50 };
static const c16 mal_string_142_code_units[] = { 110, 101, 120, 116 };
static const c16 mal_string_143_code_units[] = { 105, 116, 101, 114, 97, 116, 111, 114 };
static const c16 mal_string_144_code_units[] = { 97, 100, 100 };
static const c16 mal_string_145_code_units[] = { 118, 97, 108, 117, 101, 115 };
static const c16 mal_string_146_code_units[] = { 101, 110, 116, 114, 105, 101, 115 };
static const c16 mal_string_147_code_units[] = { 43 };
static const c16 mal_string_148_code_units[] = { 49, 43, 50, 48 };
static const c16 mal_string_149_code_units[] = { 107 };
static const c16 mal_string_150_code_units[] = { 99, 108, 101, 97, 114 };
static const c16 mal_string_151_code_units[] = { 100, 111, 110, 101 };
static const c16 mal_string_152_code_units[] = { 97, 98 };
static const c16 mal_string_153_code_units[] = { 55357, 56832, 120 };
static const c16 mal_string_154_code_units[] = { 110, 111, 112, 101 };
static const c16 mal_string_155_code_units[] = { 115, 121, 109, 98, 111, 108 };
static const c16 mal_string_156_code_units[] = { 100, 101, 115, 99, 114, 105, 112, 116, 105, 111, 110 };
static const c16 mal_string_157_code_units[] = { 83, 121, 109, 98, 111, 108, 40, 83, 121, 109, 98, 111, 108, 46, 105, 116, 101, 114, 97, 116, 111, 114, 41 };
static const c16 mal_string_158_code_units[] = { 91, 111, 98, 106, 101, 99, 116, 32, 77, 97, 112, 93 };
static const c16 mal_string_159_code_units[] = { 91, 111, 98, 106, 101, 99, 116, 32, 83, 101, 116, 93 };
static const c16 mal_string_160_code_units[] = { 91, 111, 98, 106, 101, 99, 116, 32, 83, 121, 109, 98, 111, 108, 93 };
static const c16 mal_string_161_code_units[] = { 91, 111, 98, 106, 101, 99, 116, 32, 77, 97, 116, 104, 93 };
static const c16 mal_string_162_code_units[] = { 116, 111, 83, 116, 114, 105, 110, 103, 84, 97, 103 };
static const c16 mal_string_163_code_units[] = { 67, 117, 115, 116, 111, 109 };
static const c16 mal_string_164_code_units[] = { 91, 111, 98, 106, 101, 99, 116, 32, 67, 117, 115, 116, 111, 109, 93 };
static const c16 mal_string_165_code_units[] = { 104, 97, 115, 73, 110, 115, 116, 97, 110, 99, 101 };
static const c16 mal_string_166_code_units[] = { 73, 110, 115, 116, 97, 110, 99, 101, 84, 97, 114, 103, 101, 116 };
static const c16 mal_string_167_code_units[] = { 115, 112, 101, 99, 105, 101, 115 };
static const c16 mal_string_168_code_units[] = { 105, 115, 67, 111, 110, 99, 97, 116, 83, 112, 114, 101, 97, 100, 97, 98, 108, 101 };
static const c16 mal_string_169_code_units[] = { 99, 111, 110, 99, 97, 116 };
static const c16 mal_string_170_code_units[] = { 99, 111, 108, 108, 101, 99, 116, 105, 111, 110, 115, 58 };
static const c16 mal_string_171_code_units[] = { 114, 101, 115, 117, 108, 116, 58 };
static const c16 mal_string_172_code_units[] = { 116, 109, 112, 50, 46, 106, 115, 32, 101, 120, 112, 101, 99, 116, 101, 100, 32, 114, 101, 115, 117, 108, 116, 32, 49, 55, 53, 49, 32, 98, 117, 116, 32, 103, 111, 116, 32 };

static const MalStringConstant mal_string_constants[] = {
    { .length = 0, .code_units = mal_string_0_code_units },
    { .length = 14, .code_units = mal_string_1_code_units },
    { .length = 1, .code_units = mal_string_2_code_units },
    { .length = 5, .code_units = mal_string_3_code_units },
    { .length = 8, .code_units = mal_string_4_code_units },
    { .length = 10, .code_units = mal_string_5_code_units },
    { .length = 3, .code_units = mal_string_6_code_units },
    { .length = 4, .code_units = mal_string_7_code_units },
    { .length = 6, .code_units = mal_string_8_code_units },
    { .length = 7, .code_units = mal_string_9_code_units },
    { .length = 4, .code_units = mal_string_10_code_units },
    { .length = 7, .code_units = mal_string_11_code_units },
    { .length = 4, .code_units = mal_string_12_code_units },
    { .length = 7, .code_units = mal_string_13_code_units },
    { .length = 9, .code_units = mal_string_14_code_units },
    { .length = 4, .code_units = mal_string_15_code_units },
    { .length = 4, .code_units = mal_string_16_code_units },
    { .length = 12, .code_units = mal_string_17_code_units },
    { .length = 7, .code_units = mal_string_18_code_units },
    { .length = 4, .code_units = mal_string_19_code_units },
    { .length = 5, .code_units = mal_string_20_code_units },
    { .length = 4, .code_units = mal_string_21_code_units },
    { .length = 6, .code_units = mal_string_22_code_units },
    { .length = 9, .code_units = mal_string_23_code_units },
    { .length = 5, .code_units = mal_string_24_code_units },
    { .length = 10, .code_units = mal_string_25_code_units },
    { .length = 15, .code_units = mal_string_26_code_units },
    { .length = 4, .code_units = mal_string_27_code_units },
    { .length = 11, .code_units = mal_string_28_code_units },
    { .length = 5, .code_units = mal_string_29_code_units },
    { .length = 5, .code_units = mal_string_30_code_units },
    { .length = 1, .code_units = mal_string_31_code_units },
    { .length = 2, .code_units = mal_string_32_code_units },
    { .length = 9, .code_units = mal_string_33_code_units },
    { .length = 6, .code_units = mal_string_34_code_units },
    { .length = 8, .code_units = mal_string_35_code_units },
    { .length = 7, .code_units = mal_string_36_code_units },
    { .length = 4, .code_units = mal_string_37_code_units },
    { .length = 7, .code_units = mal_string_38_code_units },
    { .length = 8, .code_units = mal_string_39_code_units },
    { .length = 9, .code_units = mal_string_40_code_units },
    { .length = 6, .code_units = mal_string_41_code_units },
    { .length = 7, .code_units = mal_string_42_code_units },
    { .length = 6, .code_units = mal_string_43_code_units },
    { .length = 8, .code_units = mal_string_44_code_units },
    { .length = 2, .code_units = mal_string_45_code_units },
    { .length = 1, .code_units = mal_string_46_code_units },
    { .length = 5, .code_units = mal_string_47_code_units },
    { .length = 5, .code_units = mal_string_48_code_units },
    { .length = 5, .code_units = mal_string_49_code_units },
    { .length = 8, .code_units = mal_string_50_code_units },
    { .length = 3, .code_units = mal_string_51_code_units },
    { .length = 12, .code_units = mal_string_52_code_units },
    { .length = 4, .code_units = mal_string_53_code_units },
    { .length = 2, .code_units = mal_string_54_code_units },
    { .length = 6, .code_units = mal_string_55_code_units },
    { .length = 3, .code_units = mal_string_56_code_units },
    { .length = 7, .code_units = mal_string_57_code_units },
    { .length = 21, .code_units = mal_string_58_code_units },
    { .length = 14, .code_units = mal_string_59_code_units },
    { .length = 36, .code_units = mal_string_60_code_units },
    { .length = 9, .code_units = mal_string_61_code_units },
    { .length = 1, .code_units = mal_string_62_code_units },
    { .length = 5, .code_units = mal_string_63_code_units },
    { .length = 7, .code_units = mal_string_64_code_units },
    { .length = 5, .code_units = mal_string_65_code_units },
    { .length = 8, .code_units = mal_string_66_code_units },
    { .length = 9, .code_units = mal_string_67_code_units },
    { .length = 9, .code_units = mal_string_68_code_units },
    { .length = 5, .code_units = mal_string_69_code_units },
    { .length = 8, .code_units = mal_string_70_code_units },
    { .length = 1, .code_units = mal_string_71_code_units },
    { .length = 5, .code_units = mal_string_72_code_units },
    { .length = 6, .code_units = mal_string_73_code_units },
    { .length = 5, .code_units = mal_string_74_code_units },
    { .length = 6, .code_units = mal_string_75_code_units },
    { .length = 6, .code_units = mal_string_76_code_units },
    { .length = 4, .code_units = mal_string_77_code_units },
    { .length = 11, .code_units = mal_string_78_code_units },
    { .length = 4, .code_units = mal_string_79_code_units },
    { .length = 1, .code_units = mal_string_80_code_units },
    { .length = 10, .code_units = mal_string_81_code_units },
    { .length = 1, .code_units = mal_string_82_code_units },
    { .length = 3, .code_units = mal_string_83_code_units },
    { .length = 3, .code_units = mal_string_84_code_units },
    { .length = 3, .code_units = mal_string_85_code_units },
    { .length = 5, .code_units = mal_string_86_code_units },
    { .length = 5, .code_units = mal_string_87_code_units },
    { .length = 5, .code_units = mal_string_88_code_units },
    { .length = 3, .code_units = mal_string_89_code_units },
    { .length = 1, .code_units = mal_string_90_code_units },
    { .length = 1, .code_units = mal_string_91_code_units },
    { .length = 5, .code_units = mal_string_92_code_units },
    { .length = 4, .code_units = mal_string_93_code_units },
    { .length = 3, .code_units = mal_string_94_code_units },
    { .length = 34, .code_units = mal_string_95_code_units },
    { .length = 1, .code_units = mal_string_96_code_units },
    { .length = 1, .code_units = mal_string_97_code_units },
    { .length = 6, .code_units = mal_string_98_code_units },
    { .length = 4, .code_units = mal_string_99_code_units },
    { .length = 7, .code_units = mal_string_100_code_units },
    { .length = 1, .code_units = mal_string_101_code_units },
    { .length = 9, .code_units = mal_string_102_code_units },
    { .length = 6, .code_units = mal_string_103_code_units },
    { .length = 12, .code_units = mal_string_104_code_units },
    { .length = 1, .code_units = mal_string_105_code_units },
    { .length = 9, .code_units = mal_string_106_code_units },
    { .length = 6, .code_units = mal_string_107_code_units },
    { .length = 5, .code_units = mal_string_108_code_units },
    { .length = 5, .code_units = mal_string_109_code_units },
    { .length = 5, .code_units = mal_string_110_code_units },
    { .length = 3, .code_units = mal_string_111_code_units },
    { .length = 4, .code_units = mal_string_112_code_units },
    { .length = 5, .code_units = mal_string_113_code_units },
    { .length = 4, .code_units = mal_string_114_code_units },
    { .length = 2, .code_units = mal_string_115_code_units },
    { .length = 5, .code_units = mal_string_116_code_units },
    { .length = 15, .code_units = mal_string_117_code_units },
    { .length = 10, .code_units = mal_string_118_code_units },
    { .length = 11, .code_units = mal_string_119_code_units },
    { .length = 10, .code_units = mal_string_120_code_units },
    { .length = 4, .code_units = mal_string_121_code_units },
    { .length = 14, .code_units = mal_string_122_code_units },
    { .length = 17, .code_units = mal_string_123_code_units },
    { .length = 18, .code_units = mal_string_124_code_units },
    { .length = 6, .code_units = mal_string_125_code_units },
    { .length = 14, .code_units = mal_string_126_code_units },
    { .length = 9, .code_units = mal_string_127_code_units },
    { .length = 14, .code_units = mal_string_128_code_units },
    { .length = 3, .code_units = mal_string_129_code_units },
    { .length = 5, .code_units = mal_string_130_code_units },
    { .length = 3, .code_units = mal_string_131_code_units },
    { .length = 3, .code_units = mal_string_132_code_units },
    { .length = 4, .code_units = mal_string_133_code_units },
    { .length = 3, .code_units = mal_string_134_code_units },
    { .length = 6, .code_units = mal_string_135_code_units },
    { .length = 3, .code_units = mal_string_136_code_units },
    { .length = 6, .code_units = mal_string_137_code_units },
    { .length = 7, .code_units = mal_string_138_code_units },
    { .length = 4, .code_units = mal_string_139_code_units },
    { .length = 4, .code_units = mal_string_140_code_units },
    { .length = 9, .code_units = mal_string_141_code_units },
    { .length = 4, .code_units = mal_string_142_code_units },
    { .length = 8, .code_units = mal_string_143_code_units },
    { .length = 3, .code_units = mal_string_144_code_units },
    { .length = 6, .code_units = mal_string_145_code_units },
    { .length = 7, .code_units = mal_string_146_code_units },
    { .length = 1, .code_units = mal_string_147_code_units },
    { .length = 4, .code_units = mal_string_148_code_units },
    { .length = 1, .code_units = mal_string_149_code_units },
    { .length = 5, .code_units = mal_string_150_code_units },
    { .length = 4, .code_units = mal_string_151_code_units },
    { .length = 2, .code_units = mal_string_152_code_units },
    { .length = 3, .code_units = mal_string_153_code_units },
    { .length = 4, .code_units = mal_string_154_code_units },
    { .length = 6, .code_units = mal_string_155_code_units },
    { .length = 11, .code_units = mal_string_156_code_units },
    { .length = 23, .code_units = mal_string_157_code_units },
    { .length = 12, .code_units = mal_string_158_code_units },
    { .length = 12, .code_units = mal_string_159_code_units },
    { .length = 15, .code_units = mal_string_160_code_units },
    { .length = 13, .code_units = mal_string_161_code_units },
    { .length = 11, .code_units = mal_string_162_code_units },
    { .length = 6, .code_units = mal_string_163_code_units },
    { .length = 15, .code_units = mal_string_164_code_units },
    { .length = 11, .code_units = mal_string_165_code_units },
    { .length = 14, .code_units = mal_string_166_code_units },
    { .length = 7, .code_units = mal_string_167_code_units },
    { .length = 18, .code_units = mal_string_168_code_units },
    { .length = 6, .code_units = mal_string_169_code_units },
    { .length = 12, .code_units = mal_string_170_code_units },
    { .length = 7, .code_units = mal_string_171_code_units },
    { .length = 37, .code_units = mal_string_172_code_units },
};

static const MalInstruction mal_function_0_instructions[] = {
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 0 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 0, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 0, .key = 1 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 2 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 4 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 5, .string_index = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 5 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 4, .key = 5, .value = 6, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 4 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 5, .value = 1 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 4, .key = 6, .value = 5, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 5, .string_index = 5 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 6, .value = 1 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 4, .key = 5, .value = 6, .enumerable = true } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 5, .callee = 2, .this_value = 0, .argument_count = 3, .arguments = (const i32[]) { 1, 3, 4 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 2 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 4, .key = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 1, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 4, .key = 3, .value = 2 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 2, .length = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 2, .key = 3, .value = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 2, .key = 4, .value = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 3 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 2, .key = 3, .value = 4 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 1 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 2, .index = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 6 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 2, .key = 4 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 4, .function_index = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 0, .callee = 3, .this_value = 2, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 2 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 0, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 7 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 0, .key = 4 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 2, .this_value = 0, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 3 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 8 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 3, .key = 4 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 4, .function_index = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 1, .callee = 0, .this_value = 3, .argument_count = 2, .arguments = (const i32[]) { 4, 2 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 4 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 1, .function_index = 3 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 5 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 6 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 5 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 2 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 1, .this_value = 2, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 65 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 6 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 5 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 3, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 88 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 4 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 11 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 2, .key = 4 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 10 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 3, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 2, .target_ip = 80 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 83 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 10 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 83 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 2, .index = 6 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 5 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 2, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 88 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 7 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 4 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 4 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 5, .callee = 3, .this_value = 4, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 97 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 106 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 4, .key = 3 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 106 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 2, .function_index = 4 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 8 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 2, .index = 8 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 14 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 4 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 15 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 7 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 4, .key = 1, .value = 0, .enumerable = true } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 2, .key = 3, .value = 4 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 8 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 3, .callee = 4, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 9 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 3, .intrinsic = MAL_INTRINSIC_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 16 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 2, .callee = 3, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 10 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 2, .intrinsic = MAL_INTRINSIC_RANGE_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 17 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 3, .callee = 2, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 11 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 3, .function_index = 5 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 12 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 12 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 19 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 3, .key = 4 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 4 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 6, .callee = 2, .this_value = 3, .argument_count = 3, .arguments = (const i32[]) { 4, 0, 1 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 13 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 12 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 20 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 6, .key = 1 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 1 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 4, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 5 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 4, .key = 3, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 6 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 4, .key = 2, .value = 3 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 0, .this_value = 6, .argument_count = 2, .arguments = (const i32[]) { 1, 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 14 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 12 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 21 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 3, .key = 4 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 10 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 0, .callee = 1, .this_value = 3, .argument_count = 2, .arguments = (const i32[]) { 4, 6 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 15 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 15 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 6 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 7 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 0, .this_value = 6, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 16 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 2 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 4, .key = 6 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 3, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 0, .key = 3 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 3, .key = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 2 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 1, .key = 4 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 0, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 2 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 3, .key = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 0, .key = 6 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 1, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 4 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 6 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 1, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 7 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 23 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 206 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 211 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 17 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 3 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 1, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 211 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 9 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 15 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 4, .key = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 10 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 11 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 1, .key = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 16 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 224 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 229 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 17 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 1, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 229 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 10 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 6, .key = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 24 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 1, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 6, .target_ip = 236 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 241 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 17 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 241 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 11 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 1, .key = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 25 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 248 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 253 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 17 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 1, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 253 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 13 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 14 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 0, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 16 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 12 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 0, .key = 6 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 15 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 6, .key = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 1, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 12 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 3, .key = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 18 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 1, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 278 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 283 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 17 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 6 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 3, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 17 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 283 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 18 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 288 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 10 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 1, .right = 3, .op = MAL_BIN_LT } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 293 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 312 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 5 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 4, .right = 3, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 306 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 7 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 1, .right = 3, .op = MAL_BIN_GT } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 312 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 18 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 4, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 18 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 306 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 3, .src = 1, .op = MAL_UNARY_PLUS } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 3, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 288 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 19 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 315 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 19 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 4 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 4, .right = 0, .op = MAL_BIN_LT } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 321 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 326 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 18 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 1, .right = 4, .op = MAL_BIN_GT } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 326 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 328 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 334 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 19 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 3, .src = 0, .op = MAL_UNARY_PLUS } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 3, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 19 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 315 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 20 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 337 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 20 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 0, .src = 4, .op = MAL_UNARY_PLUS } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 0, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 20 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 20 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 3 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 3, .right = 4, .op = MAL_BIN_LT } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 337 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 26 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 27 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 0, .key = 4 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 3, .this_value = 0, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 28 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 4, .key = 0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 0, .callee = 3, .this_value = 4, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 21 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 29 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 30 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 0, .key = 4 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 31 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 1, .callee = 3, .this_value = 0, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 22 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 1, .intrinsic = MAL_INTRINSIC_PARSE_INT } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 4 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 32 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 10 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 6, .callee = 1, .this_value = 4, .argument_count = 2, .arguments = (const i32[]) { 0, 3 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 23 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 6, .intrinsic = MAL_INTRINSIC_NUMBER_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 33 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 6, .key = 3 } },
    { .opcode = MAL_OP_CREATE_F64, .as.create_f64 = { .dst = 3, .value = 3.5e+0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 0, .this_value = 6, .argument_count = 1, .arguments = (const i32[]) { 3 } } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 373 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 376 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 379 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 379 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 24 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 23 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 4, .src = 3, .op = MAL_UNARY_NEGATE } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 25 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 2 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 3, .src = 4, .op = MAL_UNARY_TYPEOF } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 34 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 3, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 6, .target_ip = 389 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 392 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 395 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 395 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 26 } },
    { .opcode = MAL_OP_CREATE_NULL, .as.create_null = { .dst = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 4 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 3 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 3, .op = MAL_BIN_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 402 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 405 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 35 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 405 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 27 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 18 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 6, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 19 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 20 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 0, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 3, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 21 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 4, .key = 3 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 6, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 22 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 0, .key = 6 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 3, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 23 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 25 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 6, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 24 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 26 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 0, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 3, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 27 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 4, .key = 3 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 6, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 17 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 36 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 1 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 3, .key = 0, .value = 6, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 37 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 2 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 3, .key = 6, .value = 0, .enumerable = true } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 28 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 28 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 37 } },
    { .opcode = MAL_OP_DELETE_PROPERTY, .as.delete_property = { .dst = 6, .object = 3, .key = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 29 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 28 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 38 } },
    { .opcode = MAL_OP_DELETE_PROPERTY, .as.delete_property = { .dst = 3, .object = 6, .key = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 30 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 36 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 28 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 3, .right = 0, .op = MAL_BIN_IN } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 6, .target_ip = 467 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 470 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 473 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 473 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 31 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 37 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 28 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 0, .right = 6, .op = MAL_BIN_IN } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 479 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 482 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 485 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 485 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 32 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 39 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 28 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 6, .right = 3, .op = MAL_BIN_IN } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 491 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 494 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 497 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 497 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 33 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 3, .length = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 10 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 3, .key = 0, .value = 6 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 20 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 3, .key = 6, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 30 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 3, .key = 0, .value = 6 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 34 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 34 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 1 } },
    { .opcode = MAL_OP_DELETE_PROPERTY, .as.delete_property = { .dst = 5, .object = 3, .key = 6 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 1 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 34 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 6, .right = 3, .op = MAL_BIN_IN } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 517 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 520 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 523 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 523 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 35 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 34 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 3, .key = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 36 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 0 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 34 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 6, .right = 0, .op = MAL_BIN_IN } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 533 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 536 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 539 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 539 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 37 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 34 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 0, .right = 3, .op = MAL_BIN_IN } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 6, .target_ip = 545 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 548 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 551 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 551 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 38 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 12 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 3, .right = 6, .op = MAL_BIN_IN } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 557 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 560 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 563 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 563 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 39 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 14 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 8 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 6, .right = 0, .op = MAL_BIN_IN } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 569 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 572 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 575 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 575 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 40 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 41 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 34 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 22 } },
    { .opcode = MAL_OP_DELETE_PROPERTY, .as.delete_property = { .dst = 6, .object = 0, .key = 3 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 6, .target_ip = 584 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 588 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 1 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 3, .src = 6, .op = MAL_UNARY_NEGATE } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 592 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 2 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 0, .src = 3, .op = MAL_UNARY_NEGATE } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 592 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 41 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 594 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 608 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 6 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 6 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 6, .key = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 23 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 3, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 6, .target_ip = 605 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 608 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 41 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 608 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 42 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 5 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 6, .right = 0, .op = MAL_BIN_IN } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 616 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 620 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 1 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 0, .src = 3, .op = MAL_UNARY_NEGATE } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 624 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 2 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 6, .src = 0, .op = MAL_UNARY_NEGATE } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 624 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 42 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 626 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 640 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 6 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 3, .key = 6 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 23 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 0, .right = 6, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 637 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 640 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 42 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 640 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 40 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 40 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 3, .right = 6, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 645 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 648 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 651 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 651 } },
    { .opcode = MAL_OP_CREATE_NULL, .as.create_null = { .dst = 0 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 3, .src = 0, .op = MAL_UNARY_TYPEOF } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 41 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 3, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 657 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 660 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 663 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 663 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 6, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 6, .src = 0, .op = MAL_UNARY_TYPEOF } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 42 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 6, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 670 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 673 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 676 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 676 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 4, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_CREATE_F64, .as.create_f64 = { .dst = 0, .value = 5.5e+0 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 4, .src = 0, .op = MAL_UNARY_TYPEOF } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 43 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 4, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 6, .target_ip = 683 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 686 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 689 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 689 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 3, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 12 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 3, .src = 0, .op = MAL_UNARY_TYPEOF } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 44 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 3, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 696 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 699 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 702 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 702 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 6, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 28 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 6, .src = 0, .op = MAL_UNARY_TYPEOF } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 41 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 6, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 709 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 712 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 715 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 715 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 4, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 43 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 29 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 721 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 724 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 727 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 727 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 30 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 730 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 733 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 736 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 736 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 3, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 31 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 32 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 0, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 33 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 6, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 35 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 36 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 0, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 37 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 38 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 0, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 3, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 39 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 40 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 6, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 41 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 42 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 0, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 3, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 43 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 6, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 28 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 36 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 4, .key = 6 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 3, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 6 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 45 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 3 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 6, .key = 0, .value = 3, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 46 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 0, .function_index = 6 } },
    { .opcode = MAL_OP_DEFINE_ACCESSOR, .as.define_accessor = { .object = 6, .key = 3, .accessor = 0, .is_setter = false, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 46 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 3, .function_index = 7 } },
    { .opcode = MAL_OP_DEFINE_ACCESSOR, .as.define_accessor = { .object = 6, .key = 0, .accessor = 3, .is_setter = true, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 49 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 0, .function_index = 8 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 6, .key = 3, .value = 0, .enumerable = true } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 44 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 44 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 46 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 6, .key = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 45 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 44 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 46 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 5 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 3, .key = 0, .value = 6 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 44 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 46 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 6, .key = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 46 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 44 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 49 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 3, .key = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 3 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 6, .this_value = 3, .argument_count = 1, .arguments = (const i32[]) { 0 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 47 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 4 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 48 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 4, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 4, .key = 0 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 48 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 50 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 51 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 5, .function_index = 9 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 1, .key = 2, .value = 5, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 5, .string_index = 52 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 2, .value = 1 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 1, .key = 5, .value = 2, .enumerable = true } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 5, .callee = 3, .this_value = 4, .argument_count = 3, .arguments = (const i32[]) { 0, 6, 1 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 48 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 50 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 1, .key = 6 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 49 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 50 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 0, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 0, .key = 6 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 50 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 52 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 51 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 5, .function_index = 10 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 3, .key = 2, .value = 5, .enumerable = true } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 2, .callee = 1, .this_value = 0, .argument_count = 3, .arguments = (const i32[]) { 6, 4, 3 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 50 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 8 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 3, .key = 4, .value = 6 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 6 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 51 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 6, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 6, .key = 4 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 51 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 53 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 50 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 2, .callee = 3, .this_value = 6, .argument_count = 3, .arguments = (const i32[]) { 4, 0, 1 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 51 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 53 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 1, .key = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 52 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 51 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 53 } },
    { .opcode = MAL_OP_DELETE_PROPERTY, .as.delete_property = { .dst = 1, .object = 4, .key = 0 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 864 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 867 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 870 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 870 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 53 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 54 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 48 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 50 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 0, .key = 1, .value = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 879 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 893 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 4, .key = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 23 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 0, .right = 1, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 890 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 893 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 54 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 893 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 4 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 55 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 4, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 4, .key = 1 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 55 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 54 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 5, .string_index = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 2 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 3, .key = 5, .value = 2, .enumerable = true } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 5, .callee = 0, .this_value = 4, .argument_count = 3, .arguments = (const i32[]) { 1, 6, 3 } } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 56 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 55 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 54 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 9 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 3, .key = 6, .value = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 913 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 927 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 6 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 1, .key = 6 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 23 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 3, .right = 6, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 924 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 927 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 56 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 927 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 1, .function_index = 11 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 57 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 57 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 14 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 56 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 0, .function_index = 12 } },
    { .opcode = MAL_OP_DEFINE_ACCESSOR, .as.define_accessor = { .object = 3, .key = 4, .accessor = 0, .is_setter = false, .enumerable = true } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 1, .key = 6, .value = 3 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 57 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 6, .callee = 3, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 58 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 58 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 56 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 6, .key = 3 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 59 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 40 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 60 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 61 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_UNDECLARED, .as.load_undeclared = { .dst = 5, .name_string_index = 58 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 950 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 974 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 1, .key = 6 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 59 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 0, .right = 6, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 1 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 962 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 969 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 11 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 1, .key = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 60 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 0, .right = 3, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 969 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 6, .target_ip = 971 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 974 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 61 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 974 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 6, .intrinsic = MAL_INTRINSIC_JSON } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 61 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 6, .key = 1 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 62 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 4, .function_index = 13 } },
    { .opcode = MAL_OP_DEFINE_ACCESSOR, .as.define_accessor = { .object = 1, .key = 0, .accessor = 4, .is_setter = false, .enumerable = true } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 3, .this_value = 6, .argument_count = 1, .arguments = (const i32[]) { 1 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 62 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 45 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 46 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 1, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 47 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 3, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 4, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 49 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 6, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 52 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 53 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 1, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 4, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 54 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 56 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 3, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 6, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 59 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 4, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 60 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 40 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 1, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 1017 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1020 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1023 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1023 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 6, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 61 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 3, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 62 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 4, .key = 3 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 6, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 17 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 3, .function_index = 14 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 63 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 63 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 6, .callee = 3, .this_value = 1, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 64 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 64 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 5, .callee = 6, .this_value = 1, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 64 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 6 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 5, .callee = 1, .this_value = 6, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 64 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 6, .this_value = 1, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 65 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 63 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 6, .callee = 3, .this_value = 1, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 6, .this_value = 1, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 66 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 3, .function_index = 16 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 67 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 67 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 30 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 3, .this_value = 1, .argument_count = 1, .arguments = (const i32[]) { 6 } } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 6 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 7 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 4, .this_value = 6, .argument_count = 1, .arguments = (const i32[]) { 1 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 68 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 3, .function_index = 18 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 69 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 69 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 7 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 3, .this_value = 1, .argument_count = 1, .arguments = (const i32[]) { 6 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 70 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 70 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 40 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 4, .key = 6, .value = 1 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 70 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 1, .key = 6 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 71 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 65 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 66 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 6, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 4, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 68 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 1, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 71 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 4, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 17 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 1, .function_index = 21 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 14 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 1, .key = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 70 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 6, .function_index = 22 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 4, .key = 3, .value = 6, .enumerable = false } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 72 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 3, .function_index = 23 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 4, .key = 6, .value = 3, .enumerable = false } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 73 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 6, .function_index = 24 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 1, .key = 3, .value = 6, .enumerable = false } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 72 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 72 } },
    { .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = 1, .owner_function_index = 0, .index = 0 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 6, .function_index = 25 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 14 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 1, .key = 3 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 0 } },
    { .opcode = MAL_OP_SET_PROTOTYPE, .as.set_prototype = { .object = 0, .prototype = 4, .literal = false } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 78 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 0, .key = 4, .value = 6, .enumerable = false } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 6, .key = 3, .value = 0 } },
    { .opcode = MAL_OP_SET_PROTOTYPE, .as.set_prototype = { .object = 6, .prototype = 1, .literal = false } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 72 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 3, .function_index = 26 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 0, .key = 1, .value = 3, .enumerable = false } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 79 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 1, .function_index = 27 } },
    { .opcode = MAL_OP_DEFINE_ACCESSOR, .as.define_accessor = { .object = 0, .key = 3, .accessor = 1, .is_setter = false, .enumerable = false } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 70 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 3, .function_index = 28 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 0, .key = 1, .value = 3, .enumerable = false } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 73 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 73 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 3 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 1, .callee = 6, .argument_count = 1, .arguments = (const i32[]) { 3 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 74 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 74 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 70 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 3, .key = 6 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 6, .callee = 0, .this_value = 3, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 81 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 6, .right = 3, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 1143 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1146 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 5 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1149 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1149 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 1, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 74 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 79 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 3, .key = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 0, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 74 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 73 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 6, .right = 0, .op = MAL_BIN_INSTANCEOF } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 3 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 1164 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1169 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 74 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 72 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 3, .right = 6, .op = MAL_BIN_INSTANCEOF } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1169 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 1171 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1174 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1177 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1177 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 1, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 72 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 73 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 4, .key = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 1, .callee = 6, .this_value = 4, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 74 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 1, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 6, .target_ip = 1188 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1191 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1194 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1194 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 0, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 72 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 82 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 1, .callee = 4, .argument_count = 1, .arguments = (const i32[]) { 0 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 72 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 1, .key = 0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 0, .callee = 4, .this_value = 1, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 73 } },
    { .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = 1, .owner_function_index = 0, .index = 1 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 0, .function_index = 29 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 14 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 1, .key = 6 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 3 } },
    { .opcode = MAL_OP_SET_PROTOTYPE, .as.set_prototype = { .object = 3, .prototype = 4, .literal = false } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 78 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 3, .key = 4, .value = 0, .enumerable = false } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 0, .key = 6, .value = 3 } },
    { .opcode = MAL_OP_SET_PROTOTYPE, .as.set_prototype = { .object = 0, .prototype = 1, .literal = false } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 2 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 3, .callee = 0, .argument_count = 1, .arguments = (const i32[]) { 1 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 75 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 75 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 79 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 1, .key = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 3, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 17 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 0, .intrinsic = MAL_INTRINSIC_MATH } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 83 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 0, .key = 6 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 9 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 3, .this_value = 0, .argument_count = 2, .arguments = (const i32[]) { 6, 1 } } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 1, .intrinsic = MAL_INTRINSIC_MATH } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 84 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 1, .key = 6 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 5 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 2, .callee = 0, .this_value = 1, .argument_count = 2, .arguments = (const i32[]) { 6, 3 } } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 4, .right = 2, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 2, .intrinsic = MAL_INTRINSIC_MATH } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 85 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 2, .key = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 3 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 1, .src = 4, .op = MAL_UNARY_NEGATE } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 6, .this_value = 2, .argument_count = 1, .arguments = (const i32[]) { 1 } } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 3, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 4, .intrinsic = MAL_INTRINSIC_MATH } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 86 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 4, .key = 3 } },
    { .opcode = MAL_OP_CREATE_F64, .as.create_f64 = { .dst = 3, .value = 2.9e+0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 6, .callee = 2, .this_value = 4, .argument_count = 1, .arguments = (const i32[]) { 3 } } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 1, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 6, .intrinsic = MAL_INTRINSIC_MATH } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 87 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 6, .key = 1 } },
    { .opcode = MAL_OP_CREATE_F64, .as.create_f64 = { .dst = 1, .value = 2.5e+0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 2, .callee = 4, .this_value = 6, .argument_count = 1, .arguments = (const i32[]) { 1 } } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 3, .right = 2, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 2, .intrinsic = MAL_INTRINSIC_MATH } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 88 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 2, .key = 3 } },
    { .opcode = MAL_OP_CREATE_F64, .as.create_f64 = { .dst = 3, .value = 1.8e+0 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 4, .src = 3, .op = MAL_UNARY_NEGATE } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 6, .this_value = 2, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 1, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 76 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 4, .intrinsic = MAL_INTRINSIC_MATH } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 89 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 4, .key = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 10 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 6, .callee = 1, .this_value = 4, .argument_count = 2, .arguments = (const i32[]) { 3, 2 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 77 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 6, .intrinsic = MAL_INTRINSIC_JSON } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 61 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 6, .key = 2 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 2 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 90 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 2, .key = 4, .value = 1, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 91 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 4, .length = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 5, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 4, .key = 0, .value = 5 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 5, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NULL, .as.create_null = { .dst = 0 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 4, .key = 5, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 2 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 5, .string_index = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 4, .key = 0, .value = 5 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 2, .key = 1, .value = 4, .enumerable = true } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 3, .this_value = 6, .argument_count = 1, .arguments = (const i32[]) { 2 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 78 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 4, .intrinsic = MAL_INTRINSIC_JSON } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 92 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 4, .key = 2 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 2, .index = 78 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 6, .this_value = 4, .argument_count = 1, .arguments = (const i32[]) { 2 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 79 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 3, .intrinsic = MAL_INTRINSIC_GLOBAL_THIS } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 93 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 3, .key = 2 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 2, .intrinsic = MAL_INTRINSIC_MATH } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 4, .right = 2, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 1306 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1309 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1312 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1312 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 80 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 2, .intrinsic = MAL_INTRINSIC_IS_NAN } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 3 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 4, .intrinsic = MAL_INTRINSIC_NAN_VALUE } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 6, .callee = 2, .this_value = 3, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 6, .target_ip = 1319 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1322 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1325 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1325 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 81 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 4, .intrinsic = MAL_INTRINSIC_INFINITY_VALUE } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 1000000 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 4, .right = 6, .op = MAL_BIN_GT } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 1331 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1334 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1337 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1337 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 82 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 6, .intrinsic = MAL_INTRINSIC_CONSOLE } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 94 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 6, .key = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 95 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 2, .index = 77 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 0, .callee = 4, .this_value = 6, .argument_count = 2, .arguments = (const i32[]) { 3, 2 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 2, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 76 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 2, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 77 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 6, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 2, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 78 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 3, .key = 6 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 2, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 79 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 91 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 4, .key = 2 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 3, .key = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 6, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 2, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 80 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 81 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 4, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 82 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 3, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 2, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 6 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 90 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 1 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 6, .key = 4, .value = 2, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 91 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 2 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 6, .key = 2, .value = 4, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 96 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 3 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 6, .key = 4, .value = 2, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 97 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 4 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 6, .key = 2, .value = 4, .enumerable = true } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 83 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 83 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 6 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 90 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 6, .key = 4 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 84 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 91 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 6, .key = 2 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 85 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 38 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 6, .key = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 1 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 1, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 7, .target_ip = 1403 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1406 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 9 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1406 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 5, .index = 86 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 5, .string_index = 96 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 6, .key = 5 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 7 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 7, .right = 1, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 1414 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1418 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 1, .src = 8, .op = MAL_UNARY_NEGATE } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1418 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 87 } },
    { .opcode = MAL_OP_COPY_DATA_PROPERTIES, .as.copy_data_properties = { .dst = 0, .src = 6, .excluded_count = 4, .excluded = (const i32[]) { 4, 2, 3, 5 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 88 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 97 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 89 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 83 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 0 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 5, .index = 89 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 0, .key = 5 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 90 } },
    { .opcode = MAL_OP_COPY_DATA_PROPERTIES, .as.copy_data_properties = { .dst = 3, .src = 0, .excluded_count = 1, .excluded = (const i32[]) { 5 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 91 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 3, .length = 5 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 5, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 3, .key = 5, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 5, .value = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 3, .key = 0, .value = 5 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 5, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 3 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 3, .key = 5, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 5, .value = 4 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 3, .key = 0, .value = 5 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 5, .value = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 5 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 3, .key = 5, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 92 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 92 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 5, .object = 3, .key = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 5, .index = 93 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 5, .value = 2 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 3, .key = 5 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 0 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 0, .right = 2, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 1459 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1463 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 2, .src = 4, .op = MAL_UNARY_NEGATE } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 2 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1463 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 5, .index = 94 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 5, .value = 3 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 3, .key = 5 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 2 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 4 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 2, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 1471 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1474 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 8 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1474 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 5, .index = 95 } },
    { .opcode = MAL_OP_ARRAY_REST, .as.array_rest = { .dst = 5, .src = 3, .start_index = 4 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 5, .index = 96 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 5, .length = 0 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 5 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 5, .key = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 0 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 5 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 0, .right = 5, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 1486 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1489 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 6 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1489 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 97 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 3, .length = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 5, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 7 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 5, .key = 0, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 8 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 5, .key = 2, .value = 0 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 3, .key = 4, .value = 5 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 5, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 3, .key = 5 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 5, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 4, .key = 5 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 98 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 5, .object = 4, .key = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 5, .index = 99 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 5, .value = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 3, .key = 5 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 0 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 3 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 0, .right = 3, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 1517 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1520 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 4, .length = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1520 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 5 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 5, .key = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 3 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 3, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 2, .target_ip = 1528 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1531 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 20 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 2 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1531 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 100 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 5, .key = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 2 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 5 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 2, .right = 5, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 1539 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1542 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 30 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1542 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 101 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 4 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 4 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 98 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 5, .object = 4, .key = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 5 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 4 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 5, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 2, .target_ip = 1552 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1555 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 2 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1555 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 99 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 0, .key = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 4 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 5, .left = 4, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 5, .target_ip = 1563 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1566 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 5, .value = 5 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 5 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1566 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 102 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 2, .function_index = 30 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 103 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 2, .function_index = 31 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 104 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 2, .function_index = 32 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 105 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 2, .function_index = 33 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 106 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 2, .function_index = 35 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 107 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 2, .function_index = 36 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 108 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 2, .index = 103 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 5 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 1 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 0, .key = 4, .value = 3, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 3, .length = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 3, .key = 4, .value = 6 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 6 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 7 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 8 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 9 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 7, .callee = 2, .this_value = 5, .argument_count = 6, .arguments = (const i32[]) { 0, 3, 6, 4, 1, 8 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 109 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 104 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 8 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 5 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 6 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 6, .callee = 7, .this_value = 8, .argument_count = 2, .arguments = (const i32[]) { 1, 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 110 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 104 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 4 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 1, .callee = 6, .this_value = 4, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 111 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 105 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 8, .callee = 1, .this_value = 4, .argument_count = 1, .arguments = (const i32[]) { 6 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 112 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 105 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 6 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 10 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 8, .this_value = 6, .argument_count = 3, .arguments = (const i32[]) { 4, 1, 7 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 113 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 105 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 7 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 5 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 6, .callee = 3, .this_value = 7, .argument_count = 2, .arguments = (const i32[]) { 1, 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 114 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 106 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 4 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 7, .callee = 6, .this_value = 4, .argument_count = 1, .arguments = (const i32[]) { 1 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 115 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 107 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 5 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 6, .callee = 7, .this_value = 1, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 116 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 108 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 4 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 7, .callee = 6, .this_value = 4, .argument_count = 1, .arguments = (const i32[]) { 1 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 117 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 7, .function_index = 37 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 118 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 7, .function_index = 38 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 119 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 7, .function_index = 39 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 120 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 118 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 7, .key = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 4, .right = 1, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 7, .target_ip = 1651 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1654 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1657 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1657 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 119 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 7, .key = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 6, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 7, .target_ip = 1664 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1667 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1670 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1670 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 1, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 120 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 4, .key = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 6, .right = 1, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 1678 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1681 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1684 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1684 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 7, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 103 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 1, .key = 7 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 7, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 1692 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1695 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1698 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1698 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 4, .right = 7, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 105 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 7, .key = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 6, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 7, .target_ip = 1706 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1709 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1712 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1712 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 1, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 121 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 122 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 123 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 7, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 30 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 7, .key = 4, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 40 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 7, .key = 1, .value = 4 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 7 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 7, .key = 4 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 122 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 7, .key = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 123 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 4 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 111 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 7 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 4, .key = 1, .value = 7, .enumerable = true } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 4 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 111 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 4, .key = 7 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 122 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 124 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 1, .length = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 3 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 1, .key = 7, .value = 4 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 1, .key = 4 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 124 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 112 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 4, .key = 6, .value = 7 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 1, .key = 7 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 6 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 6, .right = 1, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 1759 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1762 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1762 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 124 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 113 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 4, .key = 1, .value = 7 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 7, .length = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 9 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 7, .key = 1, .value = 4 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 7 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 7, .key = 4 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 123 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 125 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 114 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 7 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 7, .key = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 126 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 7, .key = 4 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 127 } },
    { .opcode = MAL_OP_ARRAY_REST, .as.array_rest = { .dst = 1, .src = 7, .start_index = 2 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 128 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 115 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 1, .key = 7 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 129 } },
    { .opcode = MAL_OP_COPY_DATA_PROPERTIES, .as.copy_data_properties = { .dst = 4, .src = 1, .excluded_count = 1, .excluded = (const i32[]) { 7 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 130 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 131 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 4, .intrinsic = MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 116 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 1, .callee = 4, .argument_count = 1, .arguments = (const i32[]) { 7 } } },
    { .opcode = MAL_OP_THROW, .as.thrown = { .value = 1 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1823 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 1 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 11 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 1, .key = 7 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 4 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 1, .key = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 6 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 6, .right = 1, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 1812 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1815 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 35 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1815 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 71 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 4, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 7 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 1, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 131 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1823 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 132 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_CREATE_NULL, .as.create_null = { .dst = 7 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 7 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 16 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 7, .key = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1832 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1846 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 1, .key = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 23 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 7, .right = 3, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 1843 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1846 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 132 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1846 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 133 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 1 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1852 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1866 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 1, .key = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 23 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 7, .right = 3, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 1863 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1866 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 133 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1866 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 134 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_CREATE_NULL, .as.create_null = { .dst = 1 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1872 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1886 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 1, .key = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 23 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 7, .right = 3, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 1883 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1886 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 134 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1886 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 84 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 85 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 3, .right = 7, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 86 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 4, .right = 7, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 87 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 3, .right = 7, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 1, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 88 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 97 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 4, .key = 1 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 1, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 7 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 1, .key = 4 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 88 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 8, .callee = 6, .this_value = 1, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 8, .key = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 1, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 1913 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1916 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1919 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1919 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 3, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 7, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 90 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 7, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 7 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 7, .key = 3 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 91 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 6, .callee = 1, .this_value = 7, .argument_count = 1, .arguments = (const i32[]) { 3 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 6, .key = 3 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 8, .right = 7, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 4, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 93 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 94 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 3, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 95 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 8, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 7, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 96 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 8, .object = 3, .key = 7 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 96 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 7, .key = 3 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 8, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 4, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 97 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 6, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 98 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 99 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 3, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 100 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 8, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 101 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 3, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 4, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 102 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 6, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 109 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 4, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 110 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 111 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 8, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 6, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 112 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 113 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 3, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 114 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 8, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 4, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 115 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 6, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 116 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 4, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 117 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 6, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 121 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 4, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 122 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 123 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 3, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 6, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 124 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 112 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 8, .key = 6 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 124 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 113 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 6, .key = 8 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 3, .right = 7, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 4, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 125 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 8, .key = 4 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 125 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 4, .key = 8 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 3, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 7, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 126 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 90 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 8, .right = 7, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 3 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 2037 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2042 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 127 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 91 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 3, .right = 8, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2042 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 7, .target_ip = 2044 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2047 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2050 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2050 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 6, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 128 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 8, .object = 4, .key = 6 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 128 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 6, .key = 4 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 97 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 3, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 6, .target_ip = 2063 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2066 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2069 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2069 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 8, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 7, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 129 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 6, .right = 7, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 2078 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2081 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2084 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2084 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 4, .right = 7, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 130 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 7, .key = 4 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 101 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 6, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 7 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 7, .target_ip = 2095 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2106 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 7, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 7 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 7, .key = 6 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 130 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 1, .callee = 3, .this_value = 7, .argument_count = 1, .arguments = (const i32[]) { 6 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 1, .key = 6 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 7, .right = 6, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2106 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 2108 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2111 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2114 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2114 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 8, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 131 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 117 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 1, .right = 8, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 6, .target_ip = 2122 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2125 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2128 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2128 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 4, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 132 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 133 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 8, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 134 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 1, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 6, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 135 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 4, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 6, .function_index = 40 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 136 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 6, .function_index = 41 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 137 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 6, .function_index = 42 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 14 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 6, .key = 8 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 138 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 6 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 6 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 121 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 6, .key = 8 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 4 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 6 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 4, .right = 6, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 2159 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2162 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 1, .function_index = 43 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2162 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 139 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 8 } },
    { .opcode = MAL_OP_CREATE_NULL, .as.create_null = { .dst = 1 } },
    { .opcode = MAL_OP_SET_PROTOTYPE, .as.set_prototype = { .object = 8, .prototype = 1, .literal = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 90 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 1 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 8, .key = 1, .value = 6, .enumerable = true } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 140 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 8 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 5 } },
    { .opcode = MAL_OP_SET_PROTOTYPE, .as.set_prototype = { .object = 8, .prototype = 6, .literal = true } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 141 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 142 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 8, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 122 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 8, .key = 6 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 6, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 123 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 6, .key = 4 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 4 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 7, .this_value = 6, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 4 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 90 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 1 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 4, .key = 6, .value = 7, .enumerable = true } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 2, .callee = 1, .this_value = 8, .argument_count = 2, .arguments = (const i32[]) { 3, 4 } } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2191 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2205 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 8, .object = 4, .key = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 23 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 8, .right = 3, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 2202 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2205 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 142 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2205 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 4, .intrinsic = MAL_INTRINSIC_JSON } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 92 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 8, .object = 4, .key = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 124 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 1, .callee = 8, .this_value = 4, .argument_count = 1, .arguments = (const i32[]) { 3 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 143 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 1, .length = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 1, .key = 3, .value = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 1, .key = 4, .value = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 3 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 1, .key = 3, .value = 4 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 144 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 1, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 1, .key = 4 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 144 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 22 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 7 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 4 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 7, .key = 6, .value = 0, .enumerable = true } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 2, .callee = 3, .this_value = 1, .argument_count = 3, .arguments = (const i32[]) { 4, 8, 7 } } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 145 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 144 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 125 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 7, .key = 8 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 9 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 2, .callee = 4, .this_value = 7, .argument_count = 3, .arguments = (const i32[]) { 8, 1, 3 } } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2243 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2257 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 8, .object = 3, .key = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 23 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 8, .right = 1, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 2254 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2257 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 145 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2257 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 136 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 1, .key = 8 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 118 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 7, .right = 8, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 2267 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2270 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2273 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2273 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 3, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 137 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 8, .key = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 119 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 7, .right = 3, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 2283 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2286 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2289 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2289 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 1, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 138 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 3, .key = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 120 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 7, .right = 1, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 2299 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2302 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2305 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2305 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 8, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 139 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 1, .key = 8 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 121 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 7, .right = 8, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 2315 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2318 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2321 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2321 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 3, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 146 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 8, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 126 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 8, .key = 3 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 140 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 7, .this_value = 8, .argument_count = 1, .arguments = (const i32[]) { 3 } } },
    { .opcode = MAL_OP_CREATE_NULL, .as.create_null = { .dst = 3 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 4, .right = 3, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 2333 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2336 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2339 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2339 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 1, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 146 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 3, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 126 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 3, .key = 1 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 141 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 7, .callee = 4, .this_value = 3, .argument_count = 1, .arguments = (const i32[]) { 1 } } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 1, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 14 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 1, .key = 3 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 7, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 2353 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2356 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2359 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2359 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 8, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 142 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 3, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 143 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 127 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 4, .key = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 7 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 7, .right = 3, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 2373 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2376 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2379 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2379 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 8, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 146 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 128 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 3, .key = 8 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 19 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 7, .key = 8 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 143 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 127 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 0, .callee = 3, .this_value = 7, .argument_count = 2, .arguments = (const i32[]) { 8, 1 } } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 2392 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2395 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2398 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2398 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 145 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 0, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 146 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 17 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 0, .intrinsic = MAL_INTRINSIC_MAP_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 1, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 8, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 8, .key = 7, .value = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 129 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 8, .key = 3, .value = 7 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 1, .key = 4, .value = 8 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 4, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 90 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 4, .key = 7, .value = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 130 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 4, .key = 3, .value = 7 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 1, .key = 8, .value = 4 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 4, .callee = 0, .argument_count = 1, .arguments = (const i32[]) { 1 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 148 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 148 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 131 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 8, .object = 1, .key = 0 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 0, .intrinsic = MAL_INTRINSIC_NAN_VALUE } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 132 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 8, .this_value = 1, .argument_count = 2, .arguments = (const i32[]) { 0, 7 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 148 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 3, .right = 7, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 2443 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2446 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2449 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2449 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 7, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 148 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 131 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 0, .key = 7 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 3, .src = 7, .op = MAL_UNARY_NEGATE } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 133 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 1, .callee = 4, .this_value = 0, .argument_count = 2, .arguments = (const i32[]) { 3, 7 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 131 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 1, .key = 7 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 2 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 134 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 2, .callee = 3, .this_value = 1, .argument_count = 2, .arguments = (const i32[]) { 7, 0 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 148 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 77 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 7, .key = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 5 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 3, .right = 1, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 7, .target_ip = 2471 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2474 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2477 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2477 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 0, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 148 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 51 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 1, .key = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 3, .this_value = 1, .argument_count = 1, .arguments = (const i32[]) { 0 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 129 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 4, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 2489 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2492 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2495 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2495 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 7, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 148 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 51 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 0, .key = 7 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 7, .right = 3, .op = MAL_BIN_DIV } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 4, .this_value = 0, .argument_count = 1, .arguments = (const i32[]) { 8 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 132 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 3, .right = 8, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 2509 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2512 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2515 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2515 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 1, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 148 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 51 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 8, .key = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 3, .this_value = 8, .argument_count = 1, .arguments = (const i32[]) { 1 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 133 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 4, .right = 1, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 2527 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2530 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2533 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2533 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 0, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 148 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 135 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 1, .key = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 4, .this_value = 1, .argument_count = 1, .arguments = (const i32[]) { 0 } } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 3, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 2545 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2548 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2551 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2551 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 8, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 148 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 136 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 0, .key = 8 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 3, .this_value = 0, .argument_count = 1, .arguments = (const i32[]) { 8 } } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 8, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 2563 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2566 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2569 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2569 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 1, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 147 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 0, .length = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 149 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 148 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 131 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 0, .key = 8 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 90 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 137 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 2, .callee = 1, .this_value = 0, .argument_count = 2, .arguments = (const i32[]) { 8, 4 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 148 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 138 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 4, .key = 8 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 8, .function_index = 44 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 2, .callee = 0, .this_value = 4, .argument_count = 1, .arguments = (const i32[]) { 8 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 149 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 140 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 4, .key = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 31 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 1, .this_value = 4, .argument_count = 1, .arguments = (const i32[]) { 0 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 141 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 3, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 2594 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2597 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2600 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2600 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 8, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 0, .intrinsic = MAL_INTRINSIC_STRING_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 8 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 148 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 7 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 3, .key = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 1, .callee = 7, .this_value = 3, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 142 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 1, .key = 3 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 7, .this_value = 1, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 3, .key = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 1, .callee = 0, .this_value = 8, .argument_count = 1, .arguments = (const i32[]) { 7 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 90 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 1, .right = 7, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 2619 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2622 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2625 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2625 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 4, .right = 7, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 148 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 7, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 143 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 7, .key = 4 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 8, .key = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 1, .callee = 4, .this_value = 8, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 142 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 1, .key = 8 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 8, .callee = 4, .this_value = 1, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 8, .key = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 150 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 150 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 1, .key = 8 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 90 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 7, .right = 8, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 1 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 2648 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2655 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 150 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 1, .key = 7 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 137 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 0, .right = 7, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2655 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 2657 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2660 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2663 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2663 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 4, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 8, .intrinsic = MAL_INTRINSIC_SET_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 1, .length = 6 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 1, .key = 4, .value = 7 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 1, .key = 7, .value = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 1, .key = 4, .value = 7 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 3 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 1, .key = 7, .value = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 4 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 7, .intrinsic = MAL_INTRINSIC_NAN_VALUE } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 1, .key = 4, .value = 7 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 5 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 4, .intrinsic = MAL_INTRINSIC_NAN_VALUE } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 1, .key = 7, .value = 4 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 4, .callee = 8, .argument_count = 1, .arguments = (const i32[]) { 1 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 151 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 151 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 77 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 1, .key = 8 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 4 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 7, .right = 8, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 2695 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2698 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2701 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2701 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 4, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 151 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 144 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 8, .key = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 3 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 0, .callee = 7, .this_value = 8, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 151 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 0, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 2713 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2716 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2719 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2719 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 1, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 151 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 77 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 4, .key = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 4 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 0, .right = 1, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 2729 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2732 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2735 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2735 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 8, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 151 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 136 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 1, .key = 8 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 8, .intrinsic = MAL_INTRINSIC_NAN_VALUE } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 7, .callee = 0, .this_value = 1, .argument_count = 1, .arguments = (const i32[]) { 8 } } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 7, .target_ip = 2745 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2748 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2751 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2751 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 4, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 151 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 7 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 8, .key = 4 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 151 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 145 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 4, .key = 8 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 1, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 2763 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2766 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2769 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2769 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 7, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 151 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 146 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 8, .key = 0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 0, .callee = 7, .this_value = 8, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 142 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 0, .key = 8 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 8, .callee = 7, .this_value = 0, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 8, .key = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 152 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 152 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 0, .key = 8 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 1, .right = 8, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 0 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 2790 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2797 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 152 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 0, .key = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 1, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2797 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 2799 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2802 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2805 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2805 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 7, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 8, .intrinsic = MAL_INTRINSIC_SET_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 0, .length = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 0, .key = 7, .value = 1 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 1, .callee = 8, .argument_count = 1, .arguments = (const i32[]) { 0 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 153 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 1, .length = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 154 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 153 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 138 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 8, .object = 1, .key = 0 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 0, .function_index = 45 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 2, .callee = 8, .this_value = 1, .argument_count = 1, .arguments = (const i32[]) { 0 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 154 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 140 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 1, .key = 8 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 147 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 7, .this_value = 1, .argument_count = 1, .arguments = (const i32[]) { 8 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 148 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 4, .right = 8, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 2831 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2834 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2837 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2837 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 0, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 1, .intrinsic = MAL_INTRINSIC_MAP_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 8, .length = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 4, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 149 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 4, .key = 7, .value = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 4, .key = 3, .value = 7 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 8, .key = 0, .value = 4 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 4, .callee = 1, .argument_count = 1, .arguments = (const i32[]) { 8 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 155 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 155 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 146 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 4, .key = 8 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 8, .callee = 1, .this_value = 4, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 156 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 155 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 150 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 8, .key = 4 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 2, .callee = 1, .this_value = 8, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 156 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 142 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 1, .key = 4 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 0, .this_value = 1, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 151 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 4, .key = 1 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 0, .right = 1, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 2872 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2875 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2878 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2878 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 8, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 155 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 77 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 1, .key = 8 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 0, .right = 8, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 2888 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2891 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2894 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2894 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 4, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 8, .intrinsic = MAL_INTRINSIC_MAP_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_NULL, .as.create_null = { .dst = 4 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 0, .callee = 8, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 77 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 8, .object = 0, .key = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 8, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 2906 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2909 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2912 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2912 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 1, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 147 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 0, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 0, .key = 4, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 101 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 0, .key = 1, .value = 4 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 4, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 143 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 8, .object = 4, .key = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 0, .key = 8 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 8, .callee = 1, .this_value = 0, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 157 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 157 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 142 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 0, .key = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 1, .callee = 4, .this_value = 0, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 1, .key = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 4, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 2938 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2941 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2944 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2944 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 8, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 157 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 142 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 0, .key = 8 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 8, .callee = 4, .this_value = 0, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 8, .key = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 101 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 4, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 2957 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2960 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2963 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2963 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 1, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 157 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 142 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 0, .key = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 1, .callee = 4, .this_value = 0, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 151 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 1, .key = 0 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 4, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 2976 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2979 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2982 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2982 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 8, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 147 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 1, .length = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 1, .key = 0, .value = 8 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 146 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 1, .key = 8 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 8, .callee = 0, .this_value = 1, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 142 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 8, .key = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 1, .callee = 0, .this_value = 8, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 1, .key = 8 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 158 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 158 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 8, .key = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 4, .right = 1, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 8 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 3006 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3013 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 158 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 8, .key = 4 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 7, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3013 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 3015 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3018 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3021 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3021 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 0, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 147 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 8, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 7 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 8, .key = 0, .value = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 8 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 8, .key = 4, .value = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 7 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 8, .key = 0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 0, .callee = 4, .this_value = 8, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 142 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 0, .key = 8 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 8, .callee = 4, .this_value = 0, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 8, .key = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 4, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 3043 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3046 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3049 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3049 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 1, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 147 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 152 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 0, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 143 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 0, .key = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 8, .key = 4 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 1, .this_value = 8, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 159 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 159 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 142 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 8, .key = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 1, .callee = 0, .this_value = 8, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 1, .key = 8 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 90 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 0, .right = 8, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 3069 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3072 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3075 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3075 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 4, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 147 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 153 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 8, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 143 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 8, .key = 4 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 1, .key = 0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 0, .callee = 4, .this_value = 1, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 160 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 160 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 142 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 8, .object = 1, .key = 4 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 8, .this_value = 1, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 8, .object = 4, .key = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 8, .key = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 4, .right = 1, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 3097 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3100 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3103 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3103 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 0, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 160 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 142 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 1, .key = 0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 0, .callee = 4, .this_value = 1, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 0, .key = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 1, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 3116 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3119 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3122 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3122 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 8, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 147 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 161 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 161 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 1, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 143 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 1, .key = 8 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 8, .function_index = 46 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 0, .key = 4, .value = 8 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 8, .intrinsic = MAL_INTRINSIC_SET_CONSTRUCTOR } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 161 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 0, .callee = 8, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 162 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 162 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 136 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 4, .key = 8 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 10 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 7, .callee = 1, .this_value = 4, .argument_count = 1, .arguments = (const i32[]) { 8 } } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 7 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 7, .target_ip = 3145 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3152 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 162 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 136 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 7, .key = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 20 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 1, .this_value = 7, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3152 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 8 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 3155 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3162 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 162 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 77 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 8, .key = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 7, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3162 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 3164 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3167 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3170 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3170 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 0, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 3, .intrinsic = MAL_INTRINSIC_WEAK_MAP_CONSTRUCTOR } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 8, .callee = 3, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 163 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 8 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 164 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 163 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 131 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 3, .key = 0 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 164 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 42 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 1, .callee = 4, .this_value = 3, .argument_count = 2, .arguments = (const i32[]) { 0, 7 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 163 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 1, .right = 7, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 3188 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3191 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3194 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3194 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 8, .right = 7, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 163 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 51 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 7, .key = 8 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 164 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 1, .this_value = 7, .argument_count = 1, .arguments = (const i32[]) { 8 } } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 42 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 3, .right = 8, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 7, .target_ip = 3206 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3209 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3212 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3212 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 0, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 163 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 136 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 8, .key = 0 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 164 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 1, .callee = 3, .this_value = 8, .argument_count = 1, .arguments = (const i32[]) { 0 } } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 3223 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3231 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 163 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 136 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 1, .key = 8 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 8 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 3, .this_value = 1, .argument_count = 1, .arguments = (const i32[]) { 8 } } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 8, .src = 4, .op = MAL_UNARY_NOT } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3231 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 3233 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3236 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3239 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3239 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 7, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 163 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 135 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 8, .key = 7 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 164 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 1, .callee = 4, .this_value = 8, .argument_count = 1, .arguments = (const i32[]) { 7 } } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 7, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 1, .right = 7, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 3251 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3254 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3257 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3257 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 0, .right = 7, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 147 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 165 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 163 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 131 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 8, .key = 7 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 154 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 2, .callee = 0, .this_value = 8, .argument_count = 2, .arguments = (const i32[]) { 7, 1 } } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3269 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3286 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 7 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 7, .intrinsic = MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 1, .right = 7, .op = MAL_BIN_INSTANCEOF } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 3278 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3281 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3284 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3284 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 165 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3286 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 165 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 7, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 1, .intrinsic = MAL_INTRINSIC_WEAK_SET_CONSTRUCTOR } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 8, .callee = 1, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 166 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 8 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 167 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 166 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 144 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 1, .key = 7 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 167 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 0, .this_value = 1, .argument_count = 1, .arguments = (const i32[]) { 7 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 166 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 4, .right = 7, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 1 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 3306 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3313 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 166 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 136 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 1, .key = 4 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 167 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 0, .this_value = 1, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3313 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 7, .target_ip = 3315 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3318 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3321 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3321 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 8, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 3, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 8 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 3, .this_value = 8, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 8, .src = 4, .op = MAL_UNARY_TYPEOF } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 155 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 8, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 3332 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3335 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3338 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3338 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 7, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 4, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 7 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 2 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 1, .callee = 4, .this_value = 7, .argument_count = 1, .arguments = (const i32[]) { 8 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 156 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 1, .key = 8 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 7, .right = 8, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 3351 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3354 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3357 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3357 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 3, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 8, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 3 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 7, .callee = 8, .this_value = 3, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 156 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 8, .object = 7, .key = 3 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 3 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 8, .right = 3, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 7, .target_ip = 3369 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3372 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3375 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3375 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 1, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 3, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 143 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 8, .object = 3, .key = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 39 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 8, .key = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 1, .callee = 3, .this_value = 8, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 157 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 1, .right = 8, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 3388 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3391 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3394 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3394 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 7, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 147 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 168 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 3, .intrinsic = MAL_INTRINSIC_MAP_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 8 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 2, .callee = 3, .this_value = 8, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3403 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3420 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 8 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 8 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 3 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 3, .intrinsic = MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 8, .right = 3, .op = MAL_BIN_INSTANCEOF } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 7, .target_ip = 3412 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3415 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3418 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3418 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 168 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3420 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 168 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 3, .right = 7, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 147 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 169 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 8, .intrinsic = MAL_INTRINSIC_SET_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 7 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 2, .callee = 8, .this_value = 7, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3431 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3448 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 7 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 7 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 8 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 8, .intrinsic = MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 7, .right = 8, .op = MAL_BIN_INSTANCEOF } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 3440 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3443 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3446 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3446 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 169 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3448 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 169 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 8, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 147 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 170 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 7, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 2, .callee = 7, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3458 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3475 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 7 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 7 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 3 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 3, .intrinsic = MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 7, .right = 3, .op = MAL_BIN_INSTANCEOF } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 3467 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3470 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3473 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3473 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 170 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3475 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 170 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 3, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 147 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 171 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 7, .intrinsic = MAL_INTRINSIC_MAP_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 8, .length = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 8, .key = 3, .value = 1 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 2, .callee = 7, .argument_count = 1, .arguments = (const i32[]) { 8 } } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3489 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3506 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 8 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 8 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 7 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 7, .intrinsic = MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 8, .right = 7, .op = MAL_BIN_INSTANCEOF } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 3498 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3501 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3504 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3504 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 171 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3506 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 171 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 7, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 8, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 14 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 8, .key = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 39 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 8, .object = 7, .key = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 172 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 172 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 19 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 1, .key = 7 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 7, .intrinsic = MAL_INTRINSIC_MAP_CONSTRUCTOR } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 4, .callee = 7, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 7, .callee = 3, .this_value = 1, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 158 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 7, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 3527 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3530 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3533 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3533 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 8, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 172 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 19 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 4, .key = 8 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 8, .intrinsic = MAL_INTRINSIC_SET_CONSTRUCTOR } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 3, .callee = 8, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 8, .callee = 7, .this_value = 4, .argument_count = 1, .arguments = (const i32[]) { 3 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 159 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 8, .right = 3, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 3546 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3549 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3552 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3552 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 1, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 172 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 19 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 8, .object = 3, .key = 1 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 1, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 7 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 0, .callee = 1, .this_value = 7, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 7, .callee = 8, .this_value = 3, .argument_count = 1, .arguments = (const i32[]) { 0 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 160 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 7, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 3566 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3569 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3572 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3572 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 4, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 172 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 19 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 0, .key = 4 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 4, .intrinsic = MAL_INTRINSIC_MATH } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 8, .callee = 7, .this_value = 0, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 161 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 8, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 3584 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3587 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3590 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3590 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 3, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 147 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 173 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 173 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 4, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 162 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 8, .object = 4, .key = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 163 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 0, .key = 8, .value = 3 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 172 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 19 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 8, .key = 0 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 173 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 7, .callee = 4, .this_value = 8, .argument_count = 1, .arguments = (const i32[]) { 0 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 164 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 7, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 3610 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3613 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3616 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3616 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 3, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 0, .intrinsic = MAL_INTRINSIC_FUNCTION_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 14 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 0, .key = 3 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 3, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 165 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 3, .key = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 7, .key = 4 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 4, .src = 0, .op = MAL_UNARY_TYPEOF } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 44 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 4, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 7, .target_ip = 3631 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3634 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3637 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3637 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 8, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 147 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 7 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 174 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 174 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 0, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 165 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 0, .key = 8 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 8, .function_index = 48 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 7, .key = 4, .value = 8 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 147 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 42 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 174 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 7, .op = MAL_BIN_INSTANCEOF } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 3653 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3656 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3659 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3659 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 8, .right = 7, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 147 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 0, .function_index = 49 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 175 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 175 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 21 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 8, .object = 0, .key = 7 } },
    { .opcode = MAL_OP_CREATE_NULL, .as.create_null = { .dst = 7 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 8, .this_value = 0, .argument_count = 1, .arguments = (const i32[]) { 7 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 176 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 175 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 0, .callee = 7, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 176 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 0, .right = 7, .op = MAL_BIN_INSTANCEOF } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 3676 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3679 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3682 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3682 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 4, .right = 7, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 7, .intrinsic = MAL_INTRINSIC_MAP_CONSTRUCTOR } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 4, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 167 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 4, .key = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 7, .key = 3 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 3, .intrinsic = MAL_INTRINSIC_MAP_CONSTRUCTOR } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 0, .right = 3, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 7, .target_ip = 3694 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3697 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3700 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3700 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 8, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 3, .intrinsic = MAL_INTRINSIC_SET_CONSTRUCTOR } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 8, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 167 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 8, .key = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 3, .key = 4 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 4, .intrinsic = MAL_INTRINSIC_SET_CONSTRUCTOR } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 0, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 3712 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3715 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3718 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3718 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 7, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 4, .intrinsic = MAL_INTRINSIC_ARRAY_CONSTRUCTOR } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 7, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 167 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 8, .object = 7, .key = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 4, .key = 8 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 8, .intrinsic = MAL_INTRINSIC_ARRAY_CONSTRUCTOR } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 0, .right = 8, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 3730 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3733 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3736 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3736 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 3, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 147 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 4 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 22 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 2 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 4, .key = 8, .value = 3, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 90 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 4, .key = 3, .value = 8, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 91 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 4, .key = 8, .value = 3, .enumerable = true } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 177 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 177 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 3, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 168 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 3, .key = 8 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 4, .key = 0, .value = 8 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 147 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 0, .length = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 169 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 0, .key = 4 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 177 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 7, .callee = 3, .this_value = 0, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 7, .key = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 0, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 7, .target_ip = 3767 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3770 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3773 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3773 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 8, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 147 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 7, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 17 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 8, .intrinsic = MAL_INTRINSIC_CONSOLE } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 94 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 7, .object = 8, .key = 4 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 170 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 147 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 2, .callee = 7, .this_value = 8, .argument_count = 2, .arguments = (const i32[]) { 4, 0 } } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 0, .intrinsic = MAL_INTRINSIC_CONSOLE } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 94 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 8, .object = 0, .key = 4 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 171 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 17 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 2, .callee = 8, .this_value = 0, .argument_count = 2, .arguments = (const i32[]) { 4, 7 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 17 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1751 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 7, .right = 4, .op = MAL_BIN_STRICT_NEQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 3796 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3802 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 0, .intrinsic = MAL_INTRINSIC_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 172 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 17 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 4, .right = 7, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 7, .callee = 0, .argument_count = 1, .arguments = (const i32[]) { 8 } } },
    { .opcode = MAL_OP_THROW, .as.thrown = { .value = 7 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 7 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 7 } },
};

static const MalExceptionHandler mal_function_0_handlers[] = {
    { .start_ip = 58, .end_ip = 65, .handler_ip = 71 },
    { .start_ip = 90, .end_ip = 97, .handler_ip = 99 },
    { .start_ip = 578, .end_ip = 594, .handler_ip = 596 },
    { .start_ip = 610, .end_ip = 626, .handler_ip = 628 },
    { .start_ip = 873, .end_ip = 879, .handler_ip = 881 },
    { .start_ip = 907, .end_ip = 913, .handler_ip = 915 },
    { .start_ip = 947, .end_ip = 950, .handler_ip = 952 },
    { .start_ip = 1793, .end_ip = 1798, .handler_ip = 1800 },
    { .start_ip = 1825, .end_ip = 1832, .handler_ip = 1834 },
    { .start_ip = 1848, .end_ip = 1852, .handler_ip = 1854 },
    { .start_ip = 1868, .end_ip = 1872, .handler_ip = 1874 },
    { .start_ip = 2176, .end_ip = 2191, .handler_ip = 2193 },
    { .start_ip = 2234, .end_ip = 2243, .handler_ip = 2245 },
    { .start_ip = 3261, .end_ip = 3269, .handler_ip = 3271 },
    { .start_ip = 3398, .end_ip = 3403, .handler_ip = 3405 },
    { .start_ip = 3426, .end_ip = 3431, .handler_ip = 3433 },
    { .start_ip = 3454, .end_ip = 3458, .handler_ip = 3460 },
    { .start_ip = 3481, .end_ip = 3489, .handler_ip = 3491 },
};

static const MalInstruction mal_function_1_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 0, .right = 1, .op = MAL_BIN_MUL } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_2_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 1, .right = 2, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_3_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 8 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 0, .intrinsic = MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 10 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 2, .callee = 0, .argument_count = 1, .arguments = (const i32[]) { 1 } } },
    { .opcode = MAL_OP_THROW, .as.thrown = { .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 1 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_4_instructions[] = {
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_5_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 1, .right = 2, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_6_instructions[] = {
    { .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 45 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 0, .key = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 2, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_7_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 45 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 3, .right = 1, .op = MAL_BIN_MUL } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 0, .key = 2, .value = 4 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 4 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 4 } },
};

static const MalInstruction mal_function_8_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 0, .right = 1, .op = MAL_BIN_MUL } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_9_instructions[] = {
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 9 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_10_instructions[] = {
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_11_instructions[] = {
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_12_instructions[] = {
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 21 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_13_instructions[] = {
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 3 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_14_instructions[] = {
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = 0, .owner_function_index = 14, .index = 0 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 0, .function_index = 15 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_15_instructions[] = {
    { .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = 0, .owner_function_index = 14, .index = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 0, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = 2, .owner_function_index = 14, .index = 0 } },
    { .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = 2, .owner_function_index = 14, .index = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_16_instructions[] = {
    { .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = 0, .owner_function_index = 16, .index = 0 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 0, .function_index = 17 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_17_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = 0, .owner_function_index = 16, .index = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 0, .right = 2, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 1 } },
};

static const MalInstruction mal_function_18_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = 0, .owner_function_index = 18, .index = 0 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 3 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 2, .function_index = 19 } },
    { .opcode = MAL_OP_DEFINE_ACCESSOR, .as.define_accessor = { .object = 0, .key = 1, .accessor = 2, .is_setter = false, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 3 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 1, .function_index = 20 } },
    { .opcode = MAL_OP_DEFINE_ACCESSOR, .as.define_accessor = { .object = 0, .key = 2, .accessor = 1, .is_setter = true, .enumerable = true } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_19_instructions[] = {
    { .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = 0, .owner_function_index = 18, .index = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_20_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = 0, .owner_function_index = 18, .index = 0 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_21_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 15 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 0, .key = 2, .value = 3 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 3 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 3 } },
};

static const MalInstruction mal_function_22_instructions[] = {
    { .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 15 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 0, .key = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 71 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 2, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 72 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 1, .key = 2 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 2, .callee = 3, .this_value = 1, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 0, .right = 2, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 1 } },
};

static const MalInstruction mal_function_23_instructions[] = {
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_24_instructions[] = {
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 74 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_25_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = 0, .owner_function_index = 0, .index = 0 } },
    { .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = 2 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 76 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 0, .this_value = 2, .argument_count = 1, .arguments = (const i32[]) { 3 } } },
    { .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 77 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 3, .key = 2, .value = 0 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_26_instructions[] = {
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 4 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_27_instructions[] = {
    { .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 77 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 0, .key = 1 } },
    { .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 77 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 1, .key = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 2, .right = 3, .op = MAL_BIN_MUL } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_28_instructions[] = {
    { .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = 0, .owner_function_index = 0, .index = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 14 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 0, .key = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 70 } },
    { .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 2, .key = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 1, .callee = 3, .this_value = 0, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 80 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 1, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 77 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 0, .key = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 3, .right = 2, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 1 } },
};

static const MalInstruction mal_function_29_instructions[] = {
    { .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = 0, .owner_function_index = 0, .index = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 20 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 0, .key = 1 } },
    { .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = 1 } },
    { .opcode = MAL_OP_CREATE_ARGUMENTS_OBJECT, .as.create_arguments_object = { .dst = 3 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 2, .this_value = 0, .argument_count = 2, .arguments = (const i32[]) { 1, 3 } } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 3 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 3 } },
};

static const MalInstruction mal_function_30_instructions[] = {
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 2 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 5, .object = 0, .key = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 5 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 5, .string_index = 101 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 0, .key = 5 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 6 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 6, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 7, .target_ip = 11 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 14 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 10 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 14 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 5 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 1 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 1, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 6, .target_ip = 20 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 23 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 6, .length = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 23 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 5 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 5, .key = 6 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 5, .key = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 5 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 1, .right = 5, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 34 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 37 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 20 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 37 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 2 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 5 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 2, .right = 5, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 43 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 48 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 6 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 1, .right = 5, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 2 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 48 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 0 } },
    { .opcode = MAL_OP_CREATE_REST_ARGUMENTS, .as.create_rest_arguments = { .dst = 0, .start_index = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 7 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 0, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 6 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 7, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 8 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 6, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 8, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 5 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 5, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 8, .object = 4, .key = 5 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 5, .left = 2, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 5 } },
};

static const MalInstruction mal_function_31_instructions[] = {
    { .opcode = MAL_OP_CREATE_REST_ARGUMENTS, .as.create_rest_arguments = { .dst = 1, .start_index = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 2 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 1, .key = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 3, .key = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 1 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 13 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 13 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 4, .right = 2, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 1 } },
};

static const MalInstruction mal_function_32_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 4 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 5, .left = 1, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 5, .target_ip = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 11 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 5, .right = 4, .op = MAL_BIN_MUL } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 11 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 2 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 4 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 5, .left = 2, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 5, .target_ip = 17 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 22 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 5, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 2 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 22 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 0, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 1, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_33_instructions[] = {
    { .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = 0, .owner_function_index = 33, .index = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 1, .right = 2, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 9 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 3, .function_index = 34 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 9 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 3 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 3 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 2, .callee = 0, .this_value = 3, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_34_instructions[] = {
    { .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = 0, .owner_function_index = 33, .index = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 0, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_35_instructions[] = {
    { .opcode = MAL_OP_CREATE_ARGUMENTS_OBJECT, .as.create_arguments_object = { .dst = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 0 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 4 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 5, .left = 0, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 5, .target_ip = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 9 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 5, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 5 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 9 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 1 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 5 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 1, .right = 5, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 15 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 18 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 18 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 2 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 3, .key = 2 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 4 } },
};

static const MalInstruction mal_function_36_instructions[] = {
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 46 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 0, .key = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 3 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 3, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 11 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 11 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 1 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 1, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 17 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 23 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 3, .length = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 3 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 3, .key = 0, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 23 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 2, .key = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 3 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 1, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 3 } },
};

static const MalInstruction mal_function_37_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 3 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 1, .right = 3, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 9 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 9 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_38_instructions[] = {
    { .opcode = MAL_OP_CREATE_REST_ARGUMENTS, .as.create_rest_arguments = { .dst = 1, .start_index = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 2 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 1 } },
};

static const MalInstruction mal_function_39_instructions[] = {
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 2 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 0, .key = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 3 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 1, .key = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 3 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_40_instructions[] = {
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_41_instructions[] = {
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_42_instructions[] = {
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_43_instructions[] = {
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_44_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 2 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 2, .index = 149 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 139 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 2, .key = 3 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 3, .intrinsic = MAL_INTRINSIC_STRING_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 5 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 0, .callee = 3, .this_value = 5, .argument_count = 1, .arguments = (const i32[]) { 6 } } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 4, .this_value = 2, .argument_count = 1, .arguments = (const i32[]) { 0 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 147 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 1 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 148 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 2, .right = 1, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 17 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 20 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 24 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 100 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 2, .src = 4, .op = MAL_UNARY_NEGATE } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 2 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 24 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 0, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 147 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 2 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_45_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 154 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 139 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 0, .key = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 3, .this_value = 0, .argument_count = 1, .arguments = (const i32[]) { 2 } } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 2, .right = 1, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 11 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 28 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 153 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 144 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 0, .key = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 10 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 2, .this_value = 0, .argument_count = 1, .arguments = (const i32[]) { 1 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 153 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 135 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 1, .key = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 10 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 2, .this_value = 1, .argument_count = 1, .arguments = (const i32[]) { 0 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 153 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 144 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 0, .key = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 20 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 2, .this_value = 0, .argument_count = 1, .arguments = (const i32[]) { 1 } } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 1 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 1 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 1 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 1 } },
};

static const MalInstruction mal_function_46_instructions[] = {
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = 0, .owner_function_index = 46, .index = 0 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 142 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 2, .function_index = 47 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 0, .key = 1, .value = 2, .enumerable = true } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_47_instructions[] = {
    { .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = 0, .owner_function_index = 46, .index = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 0, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = 2, .owner_function_index = 46, .index = 0 } },
    { .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = 2, .owner_function_index = 46, .index = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 2, .right = 1, .op = MAL_BIN_LTE } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 9 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 20 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = 2, .owner_function_index = 46, .index = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 10 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 2, .right = 3, .op = MAL_BIN_MUL } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 0, .key = 1, .value = 4, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 151 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 0, .key = 4, .value = 1, .enumerable = true } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 29 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 3 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 3 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 0, .key = 4, .value = 3, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 151 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 0, .key = 3, .value = 4, .enumerable = true } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 29 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 1 } },
};

static const MalInstruction mal_function_48_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 42 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 0, .right = 1, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_49_instructions[] = {
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalFunction mal_functions[] = {
    {
        .name_string_index = 0,
        .parameter_count = 0,
        .length = 0,
        .register_count = 9,
        .captured_count = 2,
        .strict = true,
        .instruction_count = 3804,
        .instructions = mal_function_0_instructions,
        .handler_count = 18,
        .handlers = mal_function_0_handlers,
    },
    {
        .name_string_index = 0,
        .parameter_count = 1,
        .length = 1,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 5,
        .instructions = mal_function_1_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 0,
        .parameter_count = 2,
        .length = 2,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 6,
        .instructions = mal_function_2_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 9,
        .parameter_count = 1,
        .length = 1,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 10,
        .instructions = mal_function_3_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 13,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_4_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 18,
        .parameter_count = 2,
        .length = 2,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 6,
        .instructions = mal_function_5_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 47,
        .parameter_count = 0,
        .length = 0,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 6,
        .instructions = mal_function_6_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 48,
        .parameter_count = 1,
        .length = 1,
        .register_count = 5,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 9,
        .instructions = mal_function_7_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 49,
        .parameter_count = 1,
        .length = 1,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 5,
        .instructions = mal_function_8_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 51,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_9_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 51,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_10_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 55,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_11_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 57,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_12_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 63,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_13_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 64,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 1,
        .strict = true,
        .instruction_count = 4,
        .instructions = mal_function_14_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 0,
        .parameter_count = 0,
        .length = 0,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 6,
        .instructions = mal_function_15_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 65,
        .parameter_count = 1,
        .length = 1,
        .register_count = 1,
        .captured_count = 1,
        .strict = true,
        .instruction_count = 3,
        .instructions = mal_function_16_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 0,
        .parameter_count = 1,
        .length = 1,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 5,
        .instructions = mal_function_17_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 66,
        .parameter_count = 1,
        .length = 1,
        .register_count = 3,
        .captured_count = 1,
        .strict = true,
        .instruction_count = 11,
        .instructions = mal_function_18_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 67,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_19_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 68,
        .parameter_count = 1,
        .length = 1,
        .register_count = 2,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 5,
        .instructions = mal_function_20_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 69,
        .parameter_count = 1,
        .length = 1,
        .register_count = 4,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 7,
        .instructions = mal_function_21_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 70,
        .parameter_count = 0,
        .length = 0,
        .register_count = 4,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 11,
        .instructions = mal_function_22_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 72,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_23_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 73,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_24_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 75,
        .parameter_count = 1,
        .length = 1,
        .register_count = 5,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 11,
        .instructions = mal_function_25_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 72,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_26_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 79,
        .parameter_count = 0,
        .length = 0,
        .register_count = 4,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 8,
        .instructions = mal_function_27_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 70,
        .parameter_count = 0,
        .length = 0,
        .register_count = 4,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 14,
        .instructions = mal_function_28_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 0,
        .parameter_count = 0,
        .length = 0,
        .register_count = 5,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 8,
        .instructions = mal_function_29_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 100,
        .parameter_count = 4,
        .length = 1,
        .register_count = 9,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 65,
        .instructions = mal_function_30_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 102,
        .parameter_count = 1,
        .length = 0,
        .register_count = 5,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 15,
        .instructions = mal_function_31_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 103,
        .parameter_count = 3,
        .length = 1,
        .register_count = 6,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 29,
        .instructions = mal_function_32_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 104,
        .parameter_count = 2,
        .length = 1,
        .register_count = 4,
        .captured_count = 1,
        .strict = true,
        .instruction_count = 14,
        .instructions = mal_function_33_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 105,
        .parameter_count = 0,
        .length = 0,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 4,
        .instructions = mal_function_34_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 106,
        .parameter_count = 2,
        .length = 0,
        .register_count = 6,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 23,
        .instructions = mal_function_35_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 107,
        .parameter_count = 2,
        .length = 1,
        .register_count = 5,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 31,
        .instructions = mal_function_36_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 108,
        .parameter_count = 3,
        .length = 1,
        .register_count = 5,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 13,
        .instructions = mal_function_37_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 109,
        .parameter_count = 1,
        .length = 0,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 4,
        .instructions = mal_function_38_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 110,
        .parameter_count = 2,
        .length = 2,
        .register_count = 4,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 10,
        .instructions = mal_function_39_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 118,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_40_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 119,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_41_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 120,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_42_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 121,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_43_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 0,
        .parameter_count = 3,
        .length = 3,
        .register_count = 7,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 28,
        .instructions = mal_function_44_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 0,
        .parameter_count = 1,
        .length = 1,
        .register_count = 5,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 30,
        .instructions = mal_function_45_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 0,
        .parameter_count = 0,
        .length = 0,
        .register_count = 3,
        .captured_count = 1,
        .strict = true,
        .instruction_count = 7,
        .instructions = mal_function_46_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 142,
        .parameter_count = 0,
        .length = 0,
        .register_count = 5,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 30,
        .instructions = mal_function_47_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 0,
        .parameter_count = 1,
        .length = 1,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 5,
        .instructions = mal_function_48_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 166,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_49_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
};

const MalVmDefinition mal_vm_definition = {
    .function_count = 50,
    .functions = mal_functions,
    .string_constant_count = 173,
    .string_constants = mal_string_constants,
    .global_count = 178,
};
// === END GENERATED ===

static MalPropertyDesc test_data_desc(MalValue value, MalPropertyFlags flags) {
    return (MalPropertyDesc){
        .flags = flags,
        .value = value,
        .getter = mal_value_new_undefined(),
        .setter = mal_value_new_undefined(),
    };
}

static MalValue test_native_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) this_value;
    (void) args;

    return mal_value_from_i32(arg_count);
}

static void test_binary_value_ops_handle_int32_arithmetic(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);
    MalValue seven = mal_value_from_i32(7);
    MalValue two = mal_value_from_i32(2);

    assert(mal_value_to_i32(mal_ops_add(&heap, seven, two)) == 9);
    assert(mal_value_to_i32(mal_ops_subtract(seven, two)) == 5);
    assert(mal_value_to_i32(mal_ops_multiply(seven, two)) == 14);
    assert(mal_value_to_i32(mal_ops_remainder(seven, two)) == 1);

    mal_heap_free(&heap);
}

static void test_binary_value_ops_handle_bitwise_operations(void) {
    MalValue seven = mal_value_from_i32(7);
    MalValue two = mal_value_from_i32(2);
    MalValue negative_one = mal_value_from_i32(-1);

    assert(mal_value_to_i32(mal_ops_bit_and(seven, two)) == 2);
    assert(mal_value_to_i32(mal_ops_bit_or(seven, two)) == 7);
    assert(mal_value_to_i32(mal_ops_bit_xor(seven, two)) == 5);
    assert(mal_value_to_i32(mal_ops_shift_left(seven, two)) == 28);
    assert(mal_value_to_i32(mal_ops_shift_right(mal_value_from_i32(-8), two)) == -2);
    assert(mal_value_to_f64(mal_ops_shift_right_unsigned(negative_one, mal_value_from_i32(0))) == 4294967295.0);
}

static void test_string_values_use_utf16_code_unit_length(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    c16 pile_of_poo[] = {0xD83D, 0xDCA9};
    MalString *string = mal_string_new_copy(&heap, pile_of_poo, countof(pile_of_poo));

    assert(mal_string_length(string) == 2);
    assert(mal_string_code_units(string)[0] == 0xD83D);
    assert(mal_string_code_units(string)[1] == 0xDCA9);

    mal_heap_free(&heap);
}

static void test_string_value_ops_concatenate_and_convert_values(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalValue left = mal_value_from_string(mal_string_new_ascii(&heap, "a", lengthof("a")));
    MalValue result = mal_ops_add(&heap, left, mal_value_from_i32(1));
    MalString *string = mal_value_to_string(result);

    assert(mal_string_length(string) == 2);
    assert(mal_string_code_units(string)[0] == 'a');
    assert(mal_string_code_units(string)[1] == '1');
    assert(mal_value_to_i32(mal_ops_subtract(
        mal_value_from_string(mal_string_new_ascii(&heap, "7", lengthof("7"))),
        mal_value_from_i32(2)
    )) == 5);

    mal_heap_free(&heap);
}

static void test_string_value_ops_compare_strings_and_converted_numbers(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalValue a = mal_value_from_string(mal_string_new_ascii(&heap, "a", lengthof("a")));
    MalValue b = mal_value_from_string(mal_string_new_ascii(&heap, "b", lengthof("b")));
    MalValue ten = mal_value_from_string(mal_string_new_ascii(&heap, "10", lengthof("10")));
    MalValue two = mal_value_from_string(mal_string_new_ascii(&heap, "2", lengthof("2")));

    assert(mal_value_to_boolean(mal_ops_less_than(a, b)));
    assert(mal_value_to_boolean(mal_ops_greater_equal(b, b)));
    assert(mal_value_to_boolean(mal_ops_less_than(ten, two)));
    assert(!mal_value_to_boolean(mal_ops_less_than(mal_value_from_i32(10), two)));
    assert(mal_value_to_boolean(mal_ops_strict_equal(
        mal_value_from_string(mal_string_new_ascii(&heap, "abc", lengthof("abc"))),
        mal_value_from_string(mal_string_new_ascii(&heap, "abc", lengthof("abc")))
    )));
    assert(mal_value_to_boolean(mal_ops_equal(
        mal_value_from_string(mal_string_new_ascii(&heap, "1", lengthof("1"))),
        mal_value_from_i32(1)
    )));

    mal_heap_free(&heap);
}

static void test_vm_binary_op_dispatches_all_binary_operators(void) {
    MalVm vm;
    MalCallable callable = {.vm = &vm, .function = NULL, .registers = (MalValue[3]){0}, .instruction_pointer = 0};
    MalInstruction instruction = {.opcode = MAL_OP_BINARY, .as.binary = {.dst = 2, .left = 0, .right = 1}};

    callable.registers[0] = mal_value_from_i32(7);
    callable.registers[1] = mal_value_from_i32(2);

    instruction.as.binary.op = MAL_BIN_ADD;
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == 9);

    instruction.as.binary.op = MAL_BIN_SUB;
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == 5);

    instruction.as.binary.op = MAL_BIN_MUL;
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == 14);

    instruction.as.binary.op = MAL_BIN_REM;
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == 1);

    instruction.as.binary.op = MAL_BIN_BIT_AND;
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == 2);

    instruction.as.binary.op = MAL_BIN_BIT_OR;
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == 7);

    instruction.as.binary.op = MAL_BIN_BIT_XOR;
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == 5);

    instruction.as.binary.op = MAL_BIN_SHL;
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == 28);

    instruction.as.binary.op = MAL_BIN_SHR;
    callable.registers[0] = mal_value_from_i32(-8);
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == -2);

    instruction.as.binary.op = MAL_BIN_USHR;
    callable.registers[0] = mal_value_from_i32(-1);
    callable.registers[1] = mal_value_from_i32(0);
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_f64(callable.registers[2]) == 4294967295.0);
}

static void test_vm_call_frame_returns_to_caller(void) {
    static const i32 call_arguments[] = {1, 2};
    static const MalInstruction caller_instructions[] = {
        {.opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = {.dst = 0, .function_index = 1}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 1, .value = 2}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 2, .value = 3}},
        {.opcode = MAL_OP_CALL, .as.call = {.dst = 3, .callee = 0, .argument_count = 2, .arguments = call_arguments}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 3, .index = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 3}},
    };
    static const MalInstruction callee_instructions[] = {
        {.opcode = MAL_OP_BINARY, .as.binary = {.dst = 2, .left = 0, .right = 1, .op = MAL_BIN_ADD}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 2}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 4, .captured_count = 0, .instruction_count = 6,
            .instructions = caller_instructions
        },
        {
            .parameter_count = 2, .register_count = 3, .captured_count = 0, .instruction_count = 2,
            .instructions = callee_instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 2, .functions = functions, .string_constant_count = 0, .string_constants = NULL, .global_count = 1
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(mal_value_to_i32(vm.globals[0]) == 5);

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_vm_call_frame_fills_missing_parameters_with_undefined(void) {
    static const i32 call_arguments[] = {1};
    static const MalInstruction caller_instructions[] = {
        {.opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = {.dst = 0, .function_index = 1}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 1, .value = 2}},
        {.opcode = MAL_OP_CALL, .as.call = {.dst = 2, .callee = 0, .argument_count = 1, .arguments = call_arguments}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 2, .index = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 2}},
    };
    static const MalInstruction callee_instructions[] = {
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 1}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 3, .captured_count = 0, .instruction_count = 5,
            .instructions = caller_instructions
        },
        {
            .parameter_count = 2, .register_count = 2, .captured_count = 0, .instruction_count = 1,
            .instructions = callee_instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 2, .functions = functions, .string_constant_count = 0, .string_constants = NULL, .global_count = 1
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(mal_value_is_undefined(vm.globals[0]));

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_vm_create_string_uses_utf16_string_constants(void) {
    static const c16 code_units[] = {'o', 'k', 0xD83D, 0xDCA9};
    static const MalStringConstant string_constants[] = {
        {.length = countof(code_units), .code_units = code_units},
    };
    static const MalInstruction instructions[] = {
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 0, .string_index = 0}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 0, .index = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 1, .captured_count = 0, .instruction_count = countof(instructions),
            .instructions = instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 1,
        .functions = functions,
        .string_constant_count = countof(string_constants),
        .string_constants = string_constants,
        .global_count = 1,
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    MalString *string = mal_value_to_string(vm.globals[0]);
    assert(mal_string_length(string) == 4);
    assert(mal_string_code_units(string)[2] == 0xD83D);
    assert(mal_string_code_units(string)[3] == 0xDCA9);

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_vm_object_property_ops_create_read_and_write_properties(void) {
    static const c16 name_units[] = {'f', 'o', 'o'};
    static const c16 index_units[] = {'0'};
    static const MalStringConstant string_constants[] = {
        {.length = countof(name_units), .code_units = name_units},
        {.length = countof(index_units), .code_units = index_units},
    };
    static const MalInstruction instructions[] = {
        {.opcode = MAL_OP_CREATE_OBJECT, .as.create_object = {.dst = 0}},
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 1, .string_index = 0}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 2, .value = 3}},
        {.opcode = MAL_OP_STORE_PROPERTY, .as.store_property = {.object = 0, .key = 1, .value = 2}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 3, .value = 2}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 4, .object = 0, .key = 1}},
        {.opcode = MAL_OP_BINARY, .as.binary = {.dst = 5, .left = 4, .right = 3, .op = MAL_BIN_ADD}},
        {.opcode = MAL_OP_STORE_PROPERTY, .as.store_property = {.object = 0, .key = 1, .value = 5}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 6, .value = 0}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 7, .value = 8}},
        {.opcode = MAL_OP_STORE_PROPERTY, .as.store_property = {.object = 0, .key = 6, .value = 7}},
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 8, .string_index = 1}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 9, .object = 0, .key = 8}},
        {.opcode = MAL_OP_BINARY, .as.binary = {.dst = 10, .left = 5, .right = 9, .op = MAL_BIN_ADD}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 10, .index = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 10}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 11, .captured_count = 0, .instruction_count = countof(instructions),
            .instructions = instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 1,
        .functions = functions,
        .string_constant_count = countof(string_constants),
        .string_constants = string_constants,
        .global_count = 1,
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(mal_value_to_i32(vm.globals[0]) == 13);

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_vm_array_property_ops_manage_indices_and_length(void) {
    static const c16 length_units[] = {'l', 'e', 'n', 'g', 't', 'h'};
    static const c16 zero_units[] = {'0'};
    static const MalStringConstant string_constants[] = {
        {.length = countof(length_units), .code_units = length_units},
        {.length = countof(zero_units), .code_units = zero_units},
    };
    static const MalInstruction instructions[] = {
        {.opcode = MAL_OP_CREATE_ARRAY, .as.create_array = {.dst = 0, .length = 3}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 1, .value = 0}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 2, .value = 4}},
        {.opcode = MAL_OP_STORE_PROPERTY, .as.store_property = {.object = 0, .key = 1, .value = 2}},
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 3, .string_index = 1}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 4, .object = 0, .key = 3}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 5, .value = 5}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 6, .value = 9}},
        {.opcode = MAL_OP_STORE_PROPERTY, .as.store_property = {.object = 0, .key = 5, .value = 6}},
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 7, .string_index = 0}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 8, .object = 0, .key = 7}},
        {.opcode = MAL_OP_BINARY, .as.binary = {.dst = 9, .left = 4, .right = 8, .op = MAL_BIN_ADD}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 9, .index = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 9}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 10, .captured_count = 0, .instruction_count = countof(instructions),
            .instructions = instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 1,
        .functions = functions,
        .string_constant_count = countof(string_constants),
        .string_constants = string_constants,
        .global_count = 1,
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(mal_value_to_i32(vm.globals[0]) == 10);

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_object_new_initializes_base_state(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *prototype = mal_object_new(&heap, NULL);
    MalObject *object = mal_object_new(&heap, prototype);

    assert(object != NULL);
    assert(object->header.type == MAL_HEAP_OBJECT);
    assert(object->prototype == prototype);
    assert(object->extensible);
    assert(object->properties != NULL);
    assert(mal_table_mode(object->properties) == MAL_TABLE_MODE_OBJECT);
    assert(mal_table_size(object->properties) == 0);

    mal_heap_free(&heap);
}

static void test_string_new_copy_owns_byte_storage(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    c16 code_units[] = {'a', 'b', 'c'};
    MalString *string = mal_string_new_copy(&heap, code_units, countof(code_units));
    code_units[0] = 'z';

    assert(string != NULL);
    assert(string->header.type == MAL_HEAP_STRING);
    assert(mal_string_storage(string) == MAL_STRING_STORAGE_OWNED);
    assert(mal_string_length(string) == countof(code_units));
    assert(mal_string_code_units(string) != code_units);
    assert(mal_string_code_units(string)[0] == 'a');
    assert(mal_string_code_units(string)[1] == 'b');
    assert(mal_string_code_units(string)[2] == 'c');
    assert(mal_value_is_string(mal_value_from_string(string)));

    mal_heap_free(&heap);
}

static void test_string_new_external_borrows_code_unit_storage(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    c16 code_units[] = {'a', 'b', 'c'};
    MalString *string = mal_string_new_external(&heap, code_units, countof(code_units));

    assert(string != NULL);
    assert(string->header.type == MAL_HEAP_STRING);
    assert(mal_string_storage(string) == MAL_STRING_STORAGE_EXTERNAL);
    assert(mal_string_length(string) == countof(code_units));
    assert(mal_string_code_units(string) == code_units);

    mal_heap_free(&heap);
}

static void test_symbol_new_stores_optional_description(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalString *description = mal_string_new_ascii(&heap, "desc", lengthof("desc"));
    MalSymbol *symbol = mal_symbol_new(&heap, description);
    MalSymbol *anonymous = mal_symbol_new(&heap, NULL);

    assert(symbol != NULL);
    assert(symbol->header.type == MAL_HEAP_SYMBOL);
    assert(mal_symbol_description(symbol) == description);
    assert(mal_symbol_description(anonymous) == NULL);
    assert(symbol != anonymous);
    assert(mal_value_is_symbol(mal_value_from_symbol(symbol)));

    mal_heap_free(&heap);
}

static void test_table_uses_structural_string_keys_and_identity_symbol_keys(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalTable *table = mal_table_new(MAL_TABLE_MODE_OBJECT);
    MalString *left = mal_string_new_ascii(&heap, "key", lengthof("key"));
    MalString *right = mal_string_new_ascii(&heap, "key", lengthof("key"));
    MalSymbol *left_symbol = mal_symbol_new(&heap, left);
    MalSymbol *right_symbol = mal_symbol_new(&heap, left);

    MalKey string_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(left)};
    MalKey equivalent_string_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(right)};
    MalKey symbol_key = {.kind = MAL_KEY_SYMBOL, .value = mal_value_from_symbol(left_symbol)};
    MalKey different_symbol_key = {.kind = MAL_KEY_SYMBOL, .value = mal_value_from_symbol(right_symbol)};

    void *string_entry = mal_table_upsert_entry(table, string_key);
    void *symbol_entry = mal_table_upsert_entry(table, symbol_key);

    MalTableLookup string_lookup = mal_table_lookup(table, equivalent_string_key);
    MalTableLookup symbol_lookup = mal_table_lookup(table, different_symbol_key);

    assert(string_lookup.present);
    assert(string_lookup.entry == string_entry);
    assert(!symbol_lookup.present);
    assert(symbol_entry != NULL);
    assert(mal_table_size(table) == 2);

    mal_table_free(table);
    mal_heap_free(&heap);
}

static void test_property_define_lookup_and_entry_accessors(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalTable *table = mal_table_new(MAL_TABLE_MODE_OBJECT);
    MalString *name = mal_string_new_ascii(&heap, "name", lengthof("name"));
    MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(name)};
    MalPropertyDesc first = test_data_desc(mal_value_from_i32(1), MAL_PROPERTY_ENUMERABLE);
    MalPropertyDesc second = test_data_desc(mal_value_from_i32(2), MAL_PROPERTY_WRITABLE);

    void *entry = mal_property_define(table, key, &first);
    MalPropertyLookup lookup = mal_property_lookup(table, key);

    assert(lookup.present);
    assert(lookup.entry == entry);
    assert(mal_value_to_i32(lookup.desc.value) == 1);
    assert(lookup.desc.flags == MAL_PROPERTY_ENUMERABLE);
    assert(mal_property_entry_key(table, entry).value == key.value);

    mal_property_write_entry(table, entry, &second);

    MalPropertyDesc written = mal_property_entry_desc(table, entry);

    assert(mal_value_to_i32(written.value) == 2);
    assert(written.flags == MAL_PROPERTY_WRITABLE);
    assert(mal_table_size(table) == 1);

    mal_table_free(table);
    mal_heap_free(&heap);
}

static void test_property_set_value_creates_default_data_descriptor(void) {
    MalTable *table = mal_table_new(MAL_TABLE_MODE_OBJECT);
    MalKey key = {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)};

    void *entry = mal_property_set_value(table, key, mal_value_from_i32(42));
    MalPropertyDesc desc = mal_property_entry_desc(table, entry);

    assert(desc.flags == (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE));
    assert(mal_value_to_i32(desc.value) == 42);
    assert(mal_value_is_undefined(desc.getter));
    assert(mal_value_is_undefined(desc.setter));

    mal_table_free(table);
}

static void test_property_iter_storage_order_yields_insertion_order(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *object = mal_object_new(&heap, NULL);
    MalString *a = mal_string_new_ascii(&heap, "a", lengthof("a"));
    MalString *b = mal_string_new_ascii(&heap, "b", lengthof("b"));
    MalKey first = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(a)};
    MalKey second = {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(2)};
    MalKey third = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(b)};
    MalPropertyDesc desc = test_data_desc(mal_value_new_undefined(), MAL_PROPERTY_ENUMERABLE);

    mal_property_define(object->properties, first, &desc);
    mal_property_define(object->properties, second, &desc);
    mal_property_define(object->properties, third, &desc);

    MalPropertyIter iter;
    MalKey key;
    MalPropertyDesc out_desc;

    mal_property_iter_init(&iter, object, MAL_PROPERTY_ITER_STORAGE_ORDER);

    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.value == first.value);
    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.value == second.value);
    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.value == third.value);
    assert(!mal_property_iter_next(&iter, &key, &out_desc));

    mal_heap_free(&heap);
}

static void test_property_iter_own_property_order_groups_index_string_and_symbol_keys(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *object = mal_object_new(&heap, NULL);
    MalString *a = mal_string_new_ascii(&heap, "a", lengthof("a"));
    MalString *b = mal_string_new_ascii(&heap, "b", lengthof("b"));
    MalSymbol *left_symbol = mal_symbol_new(&heap, a);
    MalSymbol *right_symbol = mal_symbol_new(&heap, b);
    MalKey keys[] = {
        {.kind = MAL_KEY_STRING, .value = mal_value_from_string(a)},
        {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(2)},
        {.kind = MAL_KEY_SYMBOL, .value = mal_value_from_symbol(left_symbol)},
        {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(1)},
        {.kind = MAL_KEY_STRING, .value = mal_value_from_string(b)},
        {.kind = MAL_KEY_SYMBOL, .value = mal_value_from_symbol(right_symbol)},
    };
    MalPropertyDesc desc = test_data_desc(mal_value_new_undefined(), MAL_PROPERTY_ENUMERABLE);

    for (usize i = 0; i < countof(keys); i++) {
        mal_property_define(object->properties, keys[i], &desc);
    }

    MalPropertyIter iter;
    MalKey key;
    MalPropertyDesc out_desc;

    mal_property_iter_init(&iter, object, MAL_PROPERTY_ITER_OWN_PROPERTY_ORDER);

    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.kind == MAL_KEY_INDEX && mal_value_to_i32(key.value) == 1);
    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.kind == MAL_KEY_INDEX && mal_value_to_i32(key.value) == 2);
    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.value == keys[0].value);
    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.value == keys[4].value);
    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.value == keys[2].value);
    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.value == keys[5].value);
    assert(!mal_property_iter_next(&iter, &key, &out_desc));

    mal_heap_free(&heap);
}

static void test_property_iter_enumerable_own_property_order_skips_non_enumerable_entries(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *object = mal_object_new(&heap, NULL);
    MalString *visible = mal_string_new_ascii(&heap, "visible", lengthof("visible"));
    MalString *hidden = mal_string_new_ascii(&heap, "hidden", lengthof("hidden"));
    MalKey visible_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(visible)};
    MalKey hidden_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(hidden)};
    MalPropertyDesc enumerable = test_data_desc(mal_value_from_i32(1), MAL_PROPERTY_ENUMERABLE);
    MalPropertyDesc non_enumerable = test_data_desc(mal_value_from_i32(2), MAL_PROPERTY_NONE);

    mal_property_define(object->properties, hidden_key, &non_enumerable);
    mal_property_define(object->properties, visible_key, &enumerable);

    MalPropertyIter iter;
    MalKey key;
    MalPropertyDesc out_desc;

    mal_property_iter_init(&iter, object, MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);

    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.value == visible_key.value);
    assert(mal_value_to_i32(out_desc.value) == 1);
    assert(!mal_property_iter_next(&iter, &key, &out_desc));

    mal_heap_free(&heap);
}

static void test_object_ops_manage_extensibility_and_prototype_state(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *root = mal_object_new(&heap, NULL);
    MalObject *child = mal_object_new(&heap, root);

    assert(mal_object_properties(child) == child->properties);
    assert(mal_object_is_extensible(child));
    assert(mal_object_get_prototype(child) == root);
    assert(mal_object_set_prototype(root, child) == false);

    mal_object_set_extensible(child, false);

    assert(!mal_object_is_extensible(child));
    // OrdinarySetPrototypeOf: a non-extensible object only accepts its
    // current prototype.
    assert(mal_object_set_prototype(child, NULL) == false);
    assert(mal_object_get_prototype(child) == root);
    assert(mal_object_set_prototype(child, root));

    mal_heap_free(&heap);
}

static void test_object_define_own_rejects_new_properties_on_non_extensible_objects(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *object = mal_object_new(&heap, NULL);
    MalString *name = mal_string_new_ascii(&heap, "name", lengthof("name"));
    MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(name)};
    MalPropertyDesc desc = test_data_desc(mal_value_from_i32(1), MAL_PROPERTY_ENUMERABLE);

    mal_object_set_extensible(object, false);

    assert(mal_object_define_own(object, key, &desc) == MAL_DEFINE_OWN_REJECTED);
    assert(!mal_object_get_own(object, key).present);

    mal_heap_free(&heap);
}

static void test_object_define_own_rejects_incompatible_non_configurable_changes(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *object = mal_object_new(&heap, NULL);
    MalString *name = mal_string_new_ascii(&heap, "fixed", lengthof("fixed"));
    MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(name)};
    MalPropertyDesc fixed = test_data_desc(mal_value_from_i32(1), MAL_PROPERTY_NONE);
    MalPropertyDesc changed = test_data_desc(mal_value_from_i32(2), MAL_PROPERTY_NONE);

    assert(mal_object_define_own(object, key, &fixed) == MAL_DEFINE_OWN_APPLIED);
    assert(mal_object_define_own(object, key, &changed) == MAL_DEFINE_OWN_REJECTED);
    assert(mal_value_to_i32(mal_object_get_own(object, key).desc.value) == 1);

    mal_heap_free(&heap);
}

static void test_object_delete_own_respects_configurable_flag(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *object = mal_object_new(&heap, NULL);
    MalString *fixed_name = mal_string_new_ascii(&heap, "fixed", lengthof("fixed"));
    MalString *loose_name = mal_string_new_ascii(&heap, "loose", lengthof("loose"));
    MalKey fixed_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(fixed_name)};
    MalKey loose_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(loose_name)};
    MalPropertyDesc fixed = test_data_desc(mal_value_from_i32(1), MAL_PROPERTY_NONE);
    MalPropertyDesc loose = test_data_desc(mal_value_from_i32(2), MAL_PROPERTY_CONFIGURABLE);

    mal_object_define_own(object, fixed_key, &fixed);
    mal_object_define_own(object, loose_key, &loose);

    assert(!mal_object_delete_own(object, fixed_key));
    assert(mal_object_get_own(object, fixed_key).present);
    assert(mal_object_delete_own(object, loose_key));
    assert(!mal_object_get_own(object, loose_key).present);

    mal_heap_free(&heap);
}

static void test_object_resolve_property_walks_prototype_chain(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *root = mal_object_new(&heap, NULL);
    MalObject *child = mal_object_new(&heap, root);
    MalString *name = mal_string_new_ascii(&heap, "inherited", lengthof("inherited"));
    MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(name)};
    MalPropertyDesc desc = test_data_desc(mal_value_from_i32(7), MAL_PROPERTY_ENUMERABLE);

    mal_object_define_own(root, key, &desc);

    MalPropertyResolution resolution = mal_object_resolve_property(child, key);

    assert(resolution.found);
    assert(!resolution.own);
    assert(resolution.holder == root);
    assert(mal_value_to_i32(resolution.desc.value) == 7);

    mal_heap_free(&heap);
}

static void test_object_set_updates_writable_own_properties_and_creates_new_properties(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *object = mal_object_new(&heap, NULL);
    MalString *name = mal_string_new_ascii(&heap, "value", lengthof("value"));
    MalString *new_name = mal_string_new_ascii(&heap, "new", lengthof("new"));
    MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(name)};
    MalKey new_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(new_name)};
    MalPropertyDesc desc = test_data_desc(mal_value_from_i32(1), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    mal_object_define_own(object, key, &desc);

    assert(mal_object_set(object, key, mal_value_from_i32(2)));
    assert(mal_value_to_i32(mal_object_get_own(object, key).desc.value) == 2);
    assert(mal_object_set(object, new_key, mal_value_from_i32(3)));
    assert(mal_value_to_i32(mal_object_get_own(object, new_key).desc.value) == 3);

    mal_heap_free(&heap);
}

static void test_object_set_rejects_non_writable_data_properties(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *object = mal_object_new(&heap, NULL);
    MalString *name = mal_string_new_ascii(&heap, "fixed", lengthof("fixed"));
    MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(name)};
    MalPropertyDesc desc = test_data_desc(mal_value_from_i32(1), MAL_PROPERTY_CONFIGURABLE);

    mal_object_define_own(object, key, &desc);

    assert(!mal_object_set(object, key, mal_value_from_i32(2)));
    assert(mal_value_to_i32(mal_object_get_own(object, key).desc.value) == 1);

    mal_heap_free(&heap);
}

static void test_function_object_new_initializes_script_function_state(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *prototype = mal_object_new(&heap, NULL);
    MalFunctionObject *function = mal_function_object_new(&heap, prototype, 12);

    assert(function != NULL);
    assert(function->object.header.type == MAL_HEAP_FUNCTION_OBJECT);
    assert(function->object.prototype == prototype);
    assert(function->object.extensible);
    assert(mal_function_object_function_index(function) == 12);
    assert(mal_value_is_function_object(mal_value_from_function_object(function)));
    assert(mal_value_is_callable(mal_value_from_function_object(function)));

    mal_heap_free(&heap);
}

static void test_native_function_object_new_initializes_native_function_state(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalString *name = mal_string_new_ascii(&heap, "native", lengthof("native"));
    MalNativeFunctionObject *function = mal_native_function_object_new(&heap, NULL, name, test_native_callback);
    MalNativeFunctionCallback callback = mal_native_function_object_callback(function);

    assert(function != NULL);
    assert(function->object.header.type == MAL_HEAP_NATIVE_FUNCTION_OBJECT);
    assert(mal_native_function_object_name(function) == name);
    assert(callback == test_native_callback);
    assert(mal_value_to_i32(callback(NULL, mal_value_new_undefined(), NULL, 4, mal_value_new_undefined())) == 4);
    assert(mal_value_is_native_function_object(mal_value_from_native_function_object(function)));
    assert(mal_value_is_callable(mal_value_from_native_function_object(function)));

    mal_heap_free(&heap);
}

static void test_array_object_new_initializes_array_state(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *prototype = mal_object_new(&heap, NULL);
    MalArrayObject *array = mal_array_object_new(&heap, prototype);

    assert(array != NULL);
    assert(array->object.header.type == MAL_HEAP_ARRAY_OBJECT);
    assert(array->object.prototype == prototype);
    assert(array->object.extensible);
    assert(mal_array_object_length(array) == 0);

    mal_array_object_set_length(array, 10);

    assert(mal_array_object_length(array) == 10);
    assert(mal_value_is_array_object(mal_value_from_array_object(array)));
    assert(mal_value_is_object(mal_value_from_array_object(array)));

    mal_heap_free(&heap);
}

static MalValue test_builtin_get(MalVm *vm, MalValue owner, const byte *name) {
    MalPropertyResolution resolution = mal_object_resolve_property(
        mal_value_to_object(owner),
        mal_intrinsic_string_key(vm, name)
    );
    assert(resolution.found);
    return resolution.desc.value;
}

static MalValue test_builtin_call(MalVm *vm, MalValue callee, MalValue this_value, const MalValue *args, i32 arg_count) {
    MalCompletion completion = mal_vm_call_value(vm, callee, this_value, args, arg_count);
    assert(completion.kind == MAL_COMPLETION_NORMAL);
    return completion.value;
}

static MalValue test_builtin_index(MalValue array, i32 index) {
    MalPropertyResolution resolution = mal_object_resolve_property(
        mal_value_to_object(array),
        (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(index)}
    );
    return resolution.found ? resolution.desc.value : mal_value_new_undefined();
}

static bool test_builtin_value_is_ascii(MalVm *vm, MalValue value, const byte *expected) {
    return mal_value_is_string(value) && mal_string_equals(mal_value_to_string(value), mal_intrinsic_ascii(vm, expected));
}

static MalValue test_builtin_double_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) this_value;
    assert(arg_count == 3);
    return mal_value_from_i32(mal_value_to_i32(args[0]) * 2);
}

static MalValue test_builtin_is_even_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) this_value;
    assert(arg_count == 3);
    return mal_value_new_boolean(mal_value_to_i32(args[0]) % 2 == 0);
}

static MalValue test_builtin_sum_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) this_value;
    assert(arg_count == 4);
    return mal_value_from_i32(mal_value_to_i32(args[0]) + mal_value_to_i32(args[1]));
}

static i32 test_builtin_for_each_sum = 0;

static MalValue test_builtin_for_each_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) this_value;
    assert(arg_count == 3);
    test_builtin_for_each_sum += mal_value_to_i32(args[0]);
    return mal_value_new_undefined();
}

static MalValue test_builtin_native_function(MalVm *vm, const byte *name, MalNativeFunctionCallback callback) {
    return mal_value_from_native_function_object(mal_native_function_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, name),
        callback
    ));
}

static MalValue test_builtin_call_throws(MalVm *vm, MalValue callee, MalValue this_value, const MalValue *args, i32 arg_count, const byte *expected_name) {
    MalCompletion completion = mal_vm_call_value(vm, callee, this_value, args, arg_count);
    assert(completion.kind == MAL_COMPLETION_THROW);
    assert(mal_value_is_object(completion.value));
    assert(test_builtin_value_is_ascii(vm, test_builtin_get(vm, completion.value, "name"), expected_name));

    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    return completion.value;
}

static void test_builtin_error_constructors_and_to_string(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    MalValue boom = mal_value_from_string(mal_intrinsic_ascii(&vm, "boom"));
    MalValue error = test_builtin_call(&vm, vm.intrinsics[MAL_INTRINSIC_ERROR_CONSTRUCTOR], mal_value_new_undefined(), &boom, 1);
    assert(mal_value_is_object(error));
    assert(mal_object_get_prototype(mal_value_to_object(error)) == mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_ERROR_PROTOTYPE]));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_get(&vm, error, "message"), "boom"));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_get(&vm, error, "name"), "Error"));

    MalValue to_string = test_builtin_get(&vm, error, "toString");
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, to_string, error, NULL, 0), "Error: boom"));

    MalValue empty_error = test_builtin_call(&vm, vm.intrinsics[MAL_INTRINSIC_ERROR_CONSTRUCTOR], mal_value_new_undefined(), NULL, 0);
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, to_string, empty_error, NULL, 0), "Error"));

    MalValue type_error = test_builtin_call(&vm, vm.intrinsics[MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR], mal_value_new_undefined(), &boom, 1);
    MalObject *type_error_prototype = mal_object_get_prototype(mal_value_to_object(type_error));
    assert(type_error_prototype == mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE]));
    assert(mal_object_get_prototype(type_error_prototype) == mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_ERROR_PROTOTYPE]));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_get(&vm, type_error, "name"), "TypeError"));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, to_string, type_error, NULL, 0), "TypeError: boom"));

    mal_vm_free(&vm);
}

static void test_vm_throw_error_sets_completion_and_builtins_throw(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    mal_vm_throw_error(&vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "nope");
    assert(vm.completion.kind == MAL_COMPLETION_THROW);
    assert(test_builtin_value_is_ascii(&vm, test_builtin_get(&vm, vm.completion.value, "name"), "TypeError"));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_get(&vm, vm.completion.value, "message"), "nope"));
    vm.completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};

    // Reduce of an empty array without an initial value throws a TypeError.
    MalValue empty = mal_value_from_array_object(mal_intrinsic_new_array(&vm, 0));
    MalValue sum = test_builtin_native_function(&vm, "sum", test_builtin_sum_callback);
    test_builtin_call_throws(
        &vm,
        test_builtin_get(&vm, vm.intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE], "reduce"),
        empty,
        &sum,
        1,
        "TypeError"
    );

    // Object.create with a non-object prototype throws a TypeError.
    MalValue bad_prototype = mal_value_from_i32(5);
    test_builtin_call_throws(
        &vm,
        test_builtin_get(&vm, vm.intrinsics[MAL_INTRINSIC_OBJECT_CONSTRUCTOR], "create"),
        mal_value_new_undefined(),
        &bad_prototype,
        1,
        "TypeError"
    );

    mal_vm_free(&vm);
}

static void test_vm_try_catch_unwinds_to_handler(void) {
    static const MalInstruction instructions[] = {
        {.opcode = MAL_OP_TRY_BEGIN},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 0, .value = 42}},
        {.opcode = MAL_OP_THROW, .as.thrown = {.value = 0}},
        {.opcode = MAL_OP_TRY_END},
        {.opcode = MAL_OP_JUMP, .as.jump = {.target_ip = 7}},
        {.opcode = MAL_OP_CATCH, .as.caught = {.dst = 1}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 1, .index = 0}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalExceptionHandler handlers[] = {
        {.start_ip = 0, .end_ip = 4, .handler_ip = 5},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 2, .captured_count = 0, .instruction_count = 9,
            .instructions = instructions, .handler_count = 1, .handlers = handlers
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 1, .functions = functions, .string_constant_count = 0, .string_constants = NULL, .global_count = 1
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(vm.completion.kind == MAL_COMPLETION_NORMAL);
    assert(mal_value_to_i32(vm.globals[0]) == 42);

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_vm_nested_try_picks_innermost_handler_and_rethrows(void) {
    static const MalInstruction instructions[] = {
        {.opcode = MAL_OP_TRY_BEGIN},
        {.opcode = MAL_OP_TRY_BEGIN},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 0, .value = 1}},
        {.opcode = MAL_OP_THROW, .as.thrown = {.value = 0}},
        {.opcode = MAL_OP_TRY_END},
        {.opcode = MAL_OP_JUMP, .as.jump = {.target_ip = 11}},
        {.opcode = MAL_OP_CATCH, .as.caught = {.dst = 1}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 1, .index = 0}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 2, .value = 2}},
        {.opcode = MAL_OP_THROW, .as.thrown = {.value = 2}},
        {.opcode = MAL_OP_TRY_END},
        {.opcode = MAL_OP_JUMP, .as.jump = {.target_ip = 14}},
        {.opcode = MAL_OP_CATCH, .as.caught = {.dst = 3}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 3, .index = 1}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    // The outer handler is listed first on purpose: innermost selection must
    // come from range width, not table order.
    static const MalExceptionHandler handlers[] = {
        {.start_ip = 0, .end_ip = 10, .handler_ip = 12},
        {.start_ip = 1, .end_ip = 4, .handler_ip = 6},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 4, .captured_count = 0, .instruction_count = 16,
            .instructions = instructions, .handler_count = 2, .handlers = handlers
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 1, .functions = functions, .string_constant_count = 0, .string_constants = NULL, .global_count = 2
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(vm.completion.kind == MAL_COMPLETION_NORMAL);
    assert(mal_value_to_i32(vm.globals[0]) == 1);
    assert(mal_value_to_i32(vm.globals[1]) == 2);

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_vm_throw_unwinds_across_call_frames(void) {
    static const MalInstruction caller_instructions[] = {
        {.opcode = MAL_OP_TRY_BEGIN},
        {.opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = {.dst = 0, .function_index = 1}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 1}},
        {.opcode = MAL_OP_CALL, .as.call = {.dst = 2, .callee = 0, .this_value = 1, .argument_count = 0, .arguments = NULL}},
        {.opcode = MAL_OP_TRY_END},
        {.opcode = MAL_OP_JUMP, .as.jump = {.target_ip = 8}},
        {.opcode = MAL_OP_CATCH, .as.caught = {.dst = 3}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 3, .index = 0}},
        // Calling a non-function throws a TypeError.
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 0, .value = 5}},
        {.opcode = MAL_OP_TRY_BEGIN},
        {.opcode = MAL_OP_CALL, .as.call = {.dst = 1, .callee = 0, .this_value = 0, .argument_count = 0, .arguments = NULL}},
        {.opcode = MAL_OP_TRY_END},
        {.opcode = MAL_OP_JUMP, .as.jump = {.target_ip = 15}},
        {.opcode = MAL_OP_CATCH, .as.caught = {.dst = 2}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 2, .index = 1}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalInstruction callee_instructions[] = {
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 0, .value = 9}},
        {.opcode = MAL_OP_THROW, .as.thrown = {.value = 0}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalExceptionHandler caller_handlers[] = {
        {.start_ip = 0, .end_ip = 5, .handler_ip = 6},
        {.start_ip = 9, .end_ip = 12, .handler_ip = 13},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 4, .captured_count = 0, .instruction_count = 17,
            .instructions = caller_instructions, .handler_count = 2, .handlers = caller_handlers
        },
        {
            .parameter_count = 0, .register_count = 1, .captured_count = 0, .instruction_count = 4,
            .instructions = callee_instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 2, .functions = functions, .string_constant_count = 0, .string_constants = NULL, .global_count = 2
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(vm.completion.kind == MAL_COMPLETION_NORMAL);
    assert(vm.frame_count == 0);
    assert(mal_value_to_i32(vm.globals[0]) == 9);
    assert(mal_value_is_object(vm.globals[1]));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_get(&vm, vm.globals[1], "name"), "TypeError"));

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_vm_uncaught_throw_propagates_through_call_value(void) {
    static const MalInstruction throwing_instructions[] = {
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 0, .value = 9}},
        {.opcode = MAL_OP_THROW, .as.thrown = {.value = 0}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 1, .captured_count = 0, .instruction_count = 4,
            .instructions = throwing_instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 1, .functions = functions, .string_constant_count = 0, .string_constants = NULL, .global_count = 0
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);

    MalFunctionObject *function = mal_function_object_new(&vm.heap, NULL, 0);
    MalCompletion completion = mal_vm_call_value(&vm, mal_value_from_function_object(function), mal_value_new_undefined(), NULL, 0);

    assert(completion.kind == MAL_COMPLETION_THROW);
    assert(mal_value_to_i32(completion.value) == 9);
    assert(vm.frame_count == 0);

    mal_vm_free(&vm);
}

static void test_vm_construct_script_and_native_callees(void) {
    static const c16 prototype_code_units[] = {'p', 'r', 'o', 't', 'o', 't', 'y', 'p', 'e'};
    static const MalStringConstant string_constants[] = {
        {.length = 9, .code_units = prototype_code_units},
    };
    static const i32 construct_arguments[] = {2};
    static const i32 array_arguments[] = {1};
    static const MalInstruction entry_instructions[] = {
        {.opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = {.dst = 0, .function_index = 1}},
        {.opcode = MAL_OP_CREATE_OBJECT, .as.create_object = {.dst = 1}},
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 2, .string_index = 0}},
        {.opcode = MAL_OP_STORE_PROPERTY, .as.store_property = {.object = 0, .key = 2, .value = 1}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 1, .index = 1}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 2, .value = 7}},
        // Returns a number, so the constructed this is substituted.
        {.opcode = MAL_OP_CONSTRUCT, .as.construct = {.dst = 3, .callee = 0, .argument_count = 1, .arguments = construct_arguments}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 3, .index = 0}},
        {.opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = {.dst = 0, .function_index = 2}},
        // Returns an object, which wins over the constructed this.
        {.opcode = MAL_OP_CONSTRUCT, .as.construct = {.dst = 3, .callee = 0, .argument_count = 0, .arguments = NULL}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 3, .index = 2}},
        {.opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = {.dst = 0, .intrinsic = MAL_INTRINSIC_ARRAY_CONSTRUCTOR}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 1, .value = 3}},
        {.opcode = MAL_OP_CONSTRUCT, .as.construct = {.dst = 2, .callee = 0, .argument_count = 1, .arguments = array_arguments}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 2, .index = 3}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalInstruction return_param_instructions[] = {
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalInstruction return_object_instructions[] = {
        {.opcode = MAL_OP_CREATE_OBJECT, .as.create_object = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 4, .captured_count = 0, .instruction_count = 17,
            .instructions = entry_instructions
        },
        {
            .parameter_count = 1, .register_count = 1, .captured_count = 0, .instruction_count = 1,
            .instructions = return_param_instructions
        },
        {
            .parameter_count = 0, .register_count = 1, .captured_count = 0, .instruction_count = 2,
            .instructions = return_object_instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 3, .functions = functions, .string_constant_count = 1, .string_constants = string_constants, .global_count = 4
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(vm.completion.kind == MAL_COMPLETION_NORMAL);
    // The substituted this uses the callee's prototype property.
    assert(mal_value_is_object(vm.globals[0]));
    assert(mal_object_get_prototype(mal_value_to_object(vm.globals[0])) == mal_value_to_object(vm.globals[1]));
    // The explicitly returned object is an ordinary object literal.
    assert(mal_value_is_object(vm.globals[2]));
    assert(mal_object_get_prototype(mal_value_to_object(vm.globals[2])) == mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    // new Array(3) constructs through the native constructor.
    assert(mal_value_is_array_object(vm.globals[3]));
    assert(mal_array_object_length(mal_value_to_array_object(vm.globals[3])) == 3);

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_bound_function_resolution_and_calls(void) {
    static const MalInstruction add3_instructions[] = {
        {.opcode = MAL_OP_BINARY, .as.binary = {.dst = 3, .left = 0, .right = 1, .op = MAL_BIN_ADD}},
        {.opcode = MAL_OP_BINARY, .as.binary = {.dst = 4, .left = 3, .right = 2, .op = MAL_BIN_ADD}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 4}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 3, .register_count = 5, .captured_count = 0, .instruction_count = 3,
            .instructions = add3_instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 1, .functions = functions, .string_constant_count = 0, .string_constants = NULL, .global_count = 0
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);

    MalFunctionObject *target = mal_function_object_new(&vm.heap, NULL, 0);

    MalValue inner_args[] = {mal_value_from_i32(1)};
    MalBoundFunctionObject *inner = mal_bound_function_object_new(
        &vm.heap, NULL, mal_value_from_function_object(target), mal_value_from_i32(42), inner_args, 1
    );
    MalValue outer_args[] = {mal_value_from_i32(2)};
    MalBoundFunctionObject *outer = mal_bound_function_object_new(
        &vm.heap, NULL, mal_value_from_bound_function_object(inner), mal_value_from_i32(99), outer_args, 1
    );

    assert(mal_value_is_callable(mal_value_from_bound_function_object(outer)));
    assert(mal_value_is_object(mal_value_from_bound_function_object(outer)));

    // Calling the nested bound function merges argument prefixes inner-first.
    MalValue call_args[] = {mal_value_from_i32(3)};
    MalCompletion completion = mal_vm_call_value(
        &vm, mal_value_from_bound_function_object(outer), mal_value_new_undefined(), call_args, 1
    );
    assert(completion.kind == MAL_COMPLETION_NORMAL);
    assert(mal_value_to_i32(completion.value) == 6);
    assert(vm.frame_count == 0);

    // The innermost bound this wins for calls; construct ignores it.
    MalBoundResolution resolution = mal_bound_function_object_resolve(
        mal_value_from_bound_function_object(outer), mal_value_new_undefined(), call_args, 1, true
    );
    assert(resolution.callee == mal_value_from_function_object(target));
    assert(mal_value_to_i32(resolution.this_value) == 42);
    assert(resolution.arg_count == 3);
    assert(mal_value_to_i32(resolution.args[0]) == 1);
    assert(mal_value_to_i32(resolution.args[1]) == 2);
    assert(mal_value_to_i32(resolution.args[2]) == 3);
    free(resolution.owned_args);

    resolution = mal_bound_function_object_resolve(
        mal_value_from_bound_function_object(outer), mal_value_new_undefined(), call_args, 1, false
    );
    assert(mal_value_is_undefined(resolution.this_value));
    free(resolution.owned_args);

    mal_vm_free(&vm);
}

static MalValue test_builtin_pair_sum_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    assert(arg_count == 2);
    // The receiver is folded in when it is a number, to observe this-binding.
    i32 base = mal_value_is_int32(this_value) ? mal_value_to_i32(this_value) : 0;
    return mal_value_from_i32(base + mal_value_to_i32(args[0]) + mal_value_to_i32(args[1]));
}

static void test_builtin_function_call_apply_bind_and_to_string(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    MalValue function_prototype = vm.intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE];
    MalValue target = test_builtin_native_function(&vm, "pairSum", test_builtin_pair_sum_callback);

    // call(thisArg, ...args)
    MalValue call_args[] = {mal_value_from_i32(100), mal_value_from_i32(1), mal_value_from_i32(2)};
    MalValue call_result = test_builtin_call(&vm, test_builtin_get(&vm, function_prototype, "call"), target, call_args, 3);
    assert(mal_value_to_i32(call_result) == 103);

    // apply(thisArg, argsArray)
    MalArrayObject *apply_array = mal_intrinsic_new_array(&vm, 2);
    mal_object_set((MalObject *) apply_array, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)}, mal_value_from_i32(4));
    mal_object_set((MalObject *) apply_array, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(1)}, mal_value_from_i32(5));
    MalValue apply_args[] = {mal_value_from_i32(100), mal_value_from_array_object(apply_array)};
    MalValue apply_result = test_builtin_call(&vm, test_builtin_get(&vm, function_prototype, "apply"), target, apply_args, 2);
    assert(mal_value_to_i32(apply_result) == 109);

    // bind(thisArg, ...partial) creates a callable bound function.
    MalValue bind_args[] = {mal_value_from_i32(100), mal_value_from_i32(10)};
    MalValue bound = test_builtin_call(&vm, test_builtin_get(&vm, function_prototype, "bind"), target, bind_args, 2);
    assert(mal_value_is_bound_function_object(bound));
    MalValue remaining = mal_value_from_i32(7);
    MalValue bound_result = test_builtin_call(&vm, bound, mal_value_new_undefined(), &remaining, 1);
    assert(mal_value_to_i32(bound_result) == 117);

    // Bound functions inherit %Function.prototype%, so call() works on them.
    MalValue bound_call_args[] = {mal_value_new_undefined(), mal_value_from_i32(8)};
    MalValue bound_call_result = test_builtin_call(&vm, test_builtin_get(&vm, bound, "call"), bound, bound_call_args, 2);
    assert(mal_value_to_i32(bound_call_result) == 118);

    // toString stubs out the body.
    MalValue to_string_result = test_builtin_call(&vm, test_builtin_get(&vm, function_prototype, "toString"), target, NULL, 0);
    assert(test_builtin_value_is_ascii(&vm, to_string_result, "function pairSum() { [native code] }"));

    // The Function constructor throws (no eval support).
    test_builtin_call_throws(&vm, vm.intrinsics[MAL_INTRINSIC_FUNCTION_CONSTRUCTOR], mal_value_new_undefined(), NULL, 0, "TypeError");

    // call on a non-callable throws.
    MalValue non_callable_args[] = {mal_value_new_undefined()};
    test_builtin_call_throws(&vm, test_builtin_get(&vm, function_prototype, "call"), mal_value_from_i32(5), non_callable_args, 1, "TypeError");

    mal_vm_free(&vm);
}

static void test_vm_function_name_and_length_fast_path(void) {
    static const c16 name_code_units[] = {'n', 'a', 'm', 'e'};
    static const c16 length_code_units[] = {'l', 'e', 'n', 'g', 't', 'h'};
    static const c16 my_fn_code_units[] = {'m', 'y', 'F', 'n'};
    static const MalStringConstant string_constants[] = {
        {.length = 4, .code_units = name_code_units},
        {.length = 6, .code_units = length_code_units},
        {.length = 4, .code_units = my_fn_code_units},
    };
    static const MalInstruction entry_instructions[] = {
        {.opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = {.dst = 0, .function_index = 1}},
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 1, .string_index = 0}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 2, .object = 0, .key = 1}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 2, .index = 0}},
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 1, .string_index = 1}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 2, .object = 0, .key = 1}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 2, .index = 1}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalInstruction named_instructions[] = {
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 3, .captured_count = 0, .instruction_count = 9,
            .instructions = entry_instructions
        },
        {
            .name_string_index = 2, .parameter_count = 2, .length = 2, .register_count = 2, .captured_count = 0,
            .instruction_count = 1, .instructions = named_instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 2, .functions = functions, .string_constant_count = 3, .string_constants = string_constants, .global_count = 2
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(test_builtin_value_is_ascii(&vm, vm.globals[0], "myFn"));
    assert(mal_value_to_i32(vm.globals[1]) == 2);

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_builtin_object_statics_and_prototype_methods(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    MalValue object_constructor = vm.intrinsics[MAL_INTRINSIC_OBJECT_CONSTRUCTOR];
    MalPropertyFlags default_flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;

    MalValue object = test_builtin_call(&vm, object_constructor, mal_value_new_undefined(), NULL, 0);
    assert(mal_value_is_object(object));
    assert(mal_object_get_prototype(mal_value_to_object(object)) == mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));

    MalObject *descriptor = mal_intrinsic_new_object(&vm);
    mal_intrinsic_define_data(&vm, descriptor, "value", mal_value_from_i32(7), default_flags);
    mal_intrinsic_define_data(&vm, descriptor, "writable", mal_value_new_boolean(true), default_flags);
    mal_intrinsic_define_data(&vm, descriptor, "enumerable", mal_value_new_boolean(true), default_flags);

    MalValue define_property_args[] = {
        object,
        mal_value_from_string(mal_intrinsic_ascii(&vm, "x")),
        mal_value_from_object(descriptor),
    };
    test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "defineProperty"), mal_value_new_undefined(), define_property_args, 3);
    assert(mal_value_to_i32(test_builtin_get(&vm, object, "x")) == 7);

    MalValue keys = test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "keys"), mal_value_new_undefined(), &object, 1);
    assert(mal_array_object_length(mal_value_to_array_object(keys)) == 1);
    assert(test_builtin_value_is_ascii(&vm, test_builtin_index(keys, 0), "x"));

    MalValue values = test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "values"), mal_value_new_undefined(), &object, 1);
    assert(mal_value_to_i32(test_builtin_index(values, 0)) == 7);

    MalValue entries = test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "entries"), mal_value_new_undefined(), &object, 1);
    MalValue entry = test_builtin_index(entries, 0);
    assert(test_builtin_value_is_ascii(&vm, test_builtin_index(entry, 0), "x"));
    assert(mal_value_to_i32(test_builtin_index(entry, 1)) == 7);

    MalValue assign_target = mal_value_from_object(mal_intrinsic_new_object(&vm));
    MalValue assign_args[] = {assign_target, object};
    test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "assign"), mal_value_new_undefined(), assign_args, 2);
    assert(mal_value_to_i32(test_builtin_get(&vm, assign_target, "x")) == 7);

    MalValue descriptor_result = test_builtin_call(
        &vm,
        test_builtin_get(&vm, object_constructor, "getOwnPropertyDescriptor"),
        mal_value_new_undefined(),
        define_property_args,
        2
    );
    assert(mal_value_to_i32(test_builtin_get(&vm, descriptor_result, "value")) == 7);
    assert(mal_value_to_boolean(test_builtin_get(&vm, descriptor_result, "writable")));
    assert(mal_value_to_boolean(test_builtin_get(&vm, descriptor_result, "enumerable")));
    assert(!mal_value_to_boolean(test_builtin_get(&vm, descriptor_result, "configurable")));

    MalValue has_own_args[] = {object, mal_value_from_string(mal_intrinsic_ascii(&vm, "x"))};
    assert(mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "hasOwn"), mal_value_new_undefined(), has_own_args, 2)));

    MalValue object_prototype = vm.intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE];
    MalValue has_own_property = test_builtin_get(&vm, object_prototype, "hasOwnProperty");
    MalValue x_key = mal_value_from_string(mal_intrinsic_ascii(&vm, "x"));
    MalValue missing_key = mal_value_from_string(mal_intrinsic_ascii(&vm, "missing"));
    assert(mal_value_to_boolean(test_builtin_call(&vm, has_own_property, object, &x_key, 1)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, has_own_property, object, &missing_key, 1)));

    MalValue created = test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "create"), mal_value_new_undefined(), &object, 1);
    MalValue created_prototype = test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "getPrototypeOf"), mal_value_new_undefined(), &created, 1);
    assert(created_prototype == object);

    MalValue is_prototype_of = test_builtin_get(&vm, object_prototype, "isPrototypeOf");
    assert(mal_value_to_boolean(test_builtin_call(&vm, is_prototype_of, object, &created, 1)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, is_prototype_of, created, &object, 1)));

    MalValue nan_args[] = {mal_value_new_nan(), mal_value_new_nan()};
    MalValue mixed_args[] = {mal_value_from_i32(1), mal_value_from_i32(2)};
    MalValue object_is = test_builtin_get(&vm, object_constructor, "is");
    assert(mal_value_to_boolean(test_builtin_call(&vm, object_is, mal_value_new_undefined(), nan_args, 2)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, object_is, mal_value_new_undefined(), mixed_args, 2)));

    MalValue to_string = test_builtin_get(&vm, object_prototype, "toString");
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, to_string, object, NULL, 0), "[object Object]"));
    MalValue empty_array = mal_value_from_array_object(mal_intrinsic_new_array(&vm, 0));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, to_string, empty_array, NULL, 0), "[object Array]"));

    MalValue is_frozen = test_builtin_get(&vm, object_constructor, "isFrozen");
    assert(!mal_value_to_boolean(test_builtin_call(&vm, is_frozen, mal_value_new_undefined(), &object, 1)));
    test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "freeze"), mal_value_new_undefined(), &object, 1);
    assert(mal_value_to_boolean(test_builtin_call(&vm, is_frozen, mal_value_new_undefined(), &object, 1)));
    assert(!mal_object_is_extensible(mal_value_to_object(object)));
    assert(!mal_object_set(mal_value_to_object(object), mal_intrinsic_string_key(&vm, "x"), mal_value_from_i32(9)));
    assert(mal_value_to_i32(test_builtin_get(&vm, object, "x")) == 7);

    mal_vm_free(&vm);
}

static void test_builtin_array_constructor_and_prototype_methods(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    MalValue array_constructor = vm.intrinsics[MAL_INTRINSIC_ARRAY_CONSTRUCTOR];
    MalValue array_prototype = vm.intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE];
    MalValue one_two_three[] = {mal_value_from_i32(1), mal_value_from_i32(2), mal_value_from_i32(3)};

    MalValue array = test_builtin_call(&vm, array_constructor, mal_value_new_undefined(), one_two_three, 3);
    assert(mal_value_is_array_object(array));
    assert(mal_array_object_length(mal_value_to_array_object(array)) == 3);
    assert(mal_value_to_i32(test_builtin_index(array, 2)) == 3);

    MalValue sized_arg = mal_value_from_i32(5);
    MalValue sized = test_builtin_call(&vm, array_constructor, mal_value_new_undefined(), &sized_arg, 1);
    assert(mal_array_object_length(mal_value_to_array_object(sized)) == 5);
    assert(mal_value_is_undefined(test_builtin_index(sized, 0)));

    assert(mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, array_constructor, "isArray"), mal_value_new_undefined(), &array, 1)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, array_constructor, "isArray"), mal_value_new_undefined(), &sized_arg, 1)));

    MalValue of_result = test_builtin_call(&vm, test_builtin_get(&vm, array_constructor, "of"), mal_value_new_undefined(), one_two_three, 3);
    assert(mal_array_object_length(mal_value_to_array_object(of_result)) == 3);

    MalValue from_result = test_builtin_call(&vm, test_builtin_get(&vm, array_constructor, "from"), mal_value_new_undefined(), &array, 1);
    assert(mal_array_object_length(mal_value_to_array_object(from_result)) == 3);
    assert(mal_value_to_i32(test_builtin_index(from_result, 1)) == 2);

    MalValue double_value = test_builtin_native_function(&vm, "double", test_builtin_double_callback);
    MalValue mapped = test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "map"), array, &double_value, 1);
    assert(mal_array_object_length(mal_value_to_array_object(mapped)) == 3);
    assert(mal_value_to_i32(test_builtin_index(mapped, 0)) == 2);
    assert(mal_value_to_i32(test_builtin_index(mapped, 2)) == 6);

    // Holes are skipped and preserved by map.
    MalValue sparse_mapped = test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "map"), sized, &double_value, 1);
    assert(mal_array_object_length(mal_value_to_array_object(sparse_mapped)) == 5);
    assert(!mal_object_get_own(mal_value_to_object(sparse_mapped), (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)}).present);

    MalValue is_even_value = test_builtin_native_function(&vm, "isEven", test_builtin_is_even_callback);
    MalValue filtered = test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "filter"), array, &is_even_value, 1);
    assert(mal_array_object_length(mal_value_to_array_object(filtered)) == 1);
    assert(mal_value_to_i32(test_builtin_index(filtered, 0)) == 2);

    MalValue reduce_args[] = {test_builtin_native_function(&vm, "sum", test_builtin_sum_callback), mal_value_from_i32(10)};
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "reduce"), array, reduce_args, 1)) == 6);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "reduce"), array, reduce_args, 2)) == 16);

    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "find"), array, &is_even_value, 1)) == 2);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "findIndex"), array, &is_even_value, 1)) == 1);
    assert(mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "some"), array, &is_even_value, 1)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "every"), array, &is_even_value, 1)));

    test_builtin_for_each_sum = 0;
    MalValue for_each_value = test_builtin_native_function(&vm, "forEachSum", test_builtin_for_each_callback);
    test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "forEach"), array, &for_each_value, 1);
    assert(test_builtin_for_each_sum == 6);

    MalValue two = mal_value_from_i32(2);
    MalValue nine = mal_value_from_i32(9);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "indexOf"), array, &two, 1)) == 1);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "indexOf"), array, &nine, 1)) == -1);
    assert(mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "includes"), array, &two, 1)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "includes"), array, &nine, 1)));

    MalValue repeated_args[] = {mal_value_from_i32(1), mal_value_from_i32(2), mal_value_from_i32(1)};
    MalValue repeated = test_builtin_call(&vm, test_builtin_get(&vm, array_constructor, "of"), mal_value_new_undefined(), repeated_args, 3);
    MalValue one = mal_value_from_i32(1);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "lastIndexOf"), repeated, &one, 1)) == 2);

    MalValue push_args[] = {mal_value_from_i32(4), mal_value_from_i32(5)};
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "push"), array, push_args, 2)) == 5);
    assert(mal_array_object_length(mal_value_to_array_object(array)) == 5);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "pop"), array, NULL, 0)) == 5);
    assert(mal_array_object_length(mal_value_to_array_object(array)) == 4);

    MalValue slice_args[] = {mal_value_from_i32(1), mal_value_from_i32(3)};
    MalValue sliced = test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "slice"), array, slice_args, 2);
    assert(mal_array_object_length(mal_value_to_array_object(sliced)) == 2);
    assert(mal_value_to_i32(test_builtin_index(sliced, 0)) == 2);
    assert(mal_value_to_i32(test_builtin_index(sliced, 1)) == 3);

    MalValue concatenated = test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "concat"), array, &repeated, 1);
    assert(mal_array_object_length(mal_value_to_array_object(concatenated)) == 7);
    assert(mal_value_to_i32(test_builtin_index(concatenated, 4)) == 1);

    MalValue separator = mal_value_from_string(mal_intrinsic_ascii(&vm, "-"));
    MalValue joined = test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "join"), of_result, &separator, 1);
    assert(test_builtin_value_is_ascii(&vm, joined, "1-2-3"));

    test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "reverse"), of_result, NULL, 0);
    assert(mal_value_to_i32(test_builtin_index(of_result, 0)) == 3);
    assert(mal_value_to_i32(test_builtin_index(of_result, 2)) == 1);

    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "shift"), of_result, NULL, 0)) == 3);
    assert(mal_array_object_length(mal_value_to_array_object(of_result)) == 2);
    assert(mal_value_to_i32(test_builtin_index(of_result, 0)) == 2);

    MalValue seven = mal_value_from_i32(7);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "unshift"), of_result, &seven, 1)) == 3);
    assert(mal_value_to_i32(test_builtin_index(of_result, 0)) == 7);

    MalValue fill_args[] = {mal_value_from_i32(0), mal_value_from_i32(1), mal_value_from_i32(3)};
    test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "fill"), of_result, fill_args, 3);
    assert(mal_value_to_i32(test_builtin_index(of_result, 0)) == 7);
    assert(mal_value_to_i32(test_builtin_index(of_result, 1)) == 0);
    assert(mal_value_to_i32(test_builtin_index(of_result, 2)) == 0);

    MalValue negative_one = mal_value_from_i32(-1);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "at"), array, &negative_one, 1)) == 4);

    mal_vm_free(&vm);
}

static MalValue test_builtin_ascii(MalVm *vm, const byte *value) {
    return mal_value_from_string(mal_intrinsic_ascii(vm, value));
}

static void test_builtin_string_constructor_and_prototype_methods(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    MalValue string_prototype = vm.intrinsics[MAL_INTRINSIC_STRING_PROTOTYPE];
    MalValue hello = test_builtin_ascii(&vm, "Hello World");

    // String(x) coerces to a primitive string.
    MalValue five = mal_value_from_i32(5);
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, vm.intrinsics[MAL_INTRINSIC_STRING_CONSTRUCTOR], mal_value_new_undefined(), &five, 1), "5"));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, vm.intrinsics[MAL_INTRINSIC_STRING_CONSTRUCTOR], mal_value_new_undefined(), NULL, 0), ""));

    MalValue char_codes[] = {mal_value_from_i32(72), mal_value_from_i32(105)};
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, vm.intrinsics[MAL_INTRINSIC_STRING_CONSTRUCTOR], "fromCharCode"), mal_value_new_undefined(), char_codes, 2), "Hi"));

    MalValue four = mal_value_from_i32(4);
    MalValue negative_one = mal_value_from_i32(-1);
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "charAt"), hello, &four, 1), "o"));
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "charCodeAt"), hello, &four, 1)) == 'o');
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "at"), hello, &negative_one, 1), "d"));

    MalValue world = test_builtin_ascii(&vm, "World");
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "indexOf"), hello, &world, 1)) == 6);
    MalValue l_string = test_builtin_ascii(&vm, "l");
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "lastIndexOf"), hello, &l_string, 1)) == 9);
    assert(mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "includes"), hello, &world, 1)));
    MalValue hello_prefix = test_builtin_ascii(&vm, "Hello");
    assert(mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "startsWith"), hello, &hello_prefix, 1)));
    assert(mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "endsWith"), hello, &world, 1)));

    MalValue slice_args[] = {mal_value_from_i32(-5)};
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "slice"), hello, slice_args, 1), "World"));
    MalValue substring_args[] = {mal_value_from_i32(5), mal_value_from_i32(0)};
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "substring"), hello, substring_args, 2), "Hello"));

    MalValue exclaim = test_builtin_ascii(&vm, "!");
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "concat"), hello, &exclaim, 1), "Hello World!"));

    MalValue ab = test_builtin_ascii(&vm, "ab");
    MalValue three = mal_value_from_i32(3);
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "repeat"), ab, &three, 1), "ababab"));
    MalValue negative_count = mal_value_from_i32(-1);
    test_builtin_call_throws(&vm, test_builtin_get(&vm, string_prototype, "repeat"), ab, &negative_count, 1, "RangeError");

    MalValue padded = test_builtin_ascii(&vm, "  pad  ");
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "trim"), padded, NULL, 0), "pad"));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "trimStart"), padded, NULL, 0), "pad  "));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "trimEnd"), padded, NULL, 0), "  pad"));

    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "toUpperCase"), hello, NULL, 0), "HELLO WORLD"));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "toLowerCase"), hello, NULL, 0), "hello world"));

    MalValue csv = test_builtin_ascii(&vm, "a,b,c");
    MalValue comma = test_builtin_ascii(&vm, ",");
    MalValue split_result = test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "split"), csv, &comma, 1);
    assert(mal_array_object_length(mal_value_to_array_object(split_result)) == 3);
    assert(test_builtin_value_is_ascii(&vm, test_builtin_index(split_result, 1), "b"));

    MalValue replace_args[] = {l_string, test_builtin_ascii(&vm, "L")};
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "replace"), hello, replace_args, 2), "HeLlo World"));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "replaceAll"), hello, replace_args, 2), "HeLLo WorLd"));

    MalValue pad_args[] = {mal_value_from_i32(5), test_builtin_ascii(&vm, "0")};
    MalValue forty_two = test_builtin_ascii(&vm, "42");
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "padStart"), forty_two, pad_args, 2), "00042"));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "padEnd"), forty_two, pad_args, 2), "42000"));

    mal_vm_free(&vm);
}

static void test_builtin_number_boolean_and_global_functions(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    MalValue number_constructor = vm.intrinsics[MAL_INTRINSIC_NUMBER_CONSTRUCTOR];
    MalValue number_prototype = vm.intrinsics[MAL_INTRINSIC_NUMBER_PROTOTYPE];

    MalValue forty_two_string = test_builtin_ascii(&vm, "42");
    assert(mal_value_to_i32(test_builtin_call(&vm, number_constructor, mal_value_new_undefined(), &forty_two_string, 1)) == 42);
    assert(mal_value_to_i32(test_builtin_call(&vm, number_constructor, mal_value_new_undefined(), NULL, 0)) == 0);

    MalValue three = mal_value_from_i32(3);
    MalValue three_point_five = mal_value_from_f64(3.5);
    assert(mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, number_constructor, "isInteger"), mal_value_new_undefined(), &three, 1)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, number_constructor, "isInteger"), mal_value_new_undefined(), &three_point_five, 1)));

    MalValue nan_value = mal_value_new_nan();
    assert(mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, number_constructor, "isNaN"), mal_value_new_undefined(), &nan_value, 1)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, number_constructor, "isNaN"), mal_value_new_undefined(), &three, 1)));
    assert(mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, number_constructor, "isFinite"), mal_value_new_undefined(), &three, 1)));

    // parseInt handles radix, hex prefixes and trailing garbage.
    MalValue parse_int = vm.intrinsics[MAL_INTRINSIC_PARSE_INT];
    MalValue int_args[] = {test_builtin_ascii(&vm, "  -42px")};
    assert(mal_value_to_i32(test_builtin_call(&vm, parse_int, mal_value_new_undefined(), int_args, 1)) == -42);
    MalValue hex_args[] = {test_builtin_ascii(&vm, "0xff")};
    assert(mal_value_to_i32(test_builtin_call(&vm, parse_int, mal_value_new_undefined(), hex_args, 1)) == 255);
    MalValue binary_args[] = {test_builtin_ascii(&vm, "101"), mal_value_from_i32(2)};
    assert(mal_value_to_i32(test_builtin_call(&vm, parse_int, mal_value_new_undefined(), binary_args, 2)) == 5);
    MalValue garbage_args[] = {test_builtin_ascii(&vm, "nope")};
    assert(mal_value_is_nan(test_builtin_call(&vm, parse_int, mal_value_new_undefined(), garbage_args, 1)));

    MalValue parse_float = vm.intrinsics[MAL_INTRINSIC_PARSE_FLOAT];
    MalValue float_args[] = {test_builtin_ascii(&vm, "3.5rem")};
    assert(mal_value_to_f64(test_builtin_call(&vm, parse_float, mal_value_new_undefined(), float_args, 1)) == 3.5);

    // Global isNaN coerces, Number.isNaN does not.
    MalValue nan_string = test_builtin_ascii(&vm, "not a number");
    assert(mal_value_to_boolean(test_builtin_call(&vm, vm.intrinsics[MAL_INTRINSIC_IS_NAN], mal_value_new_undefined(), &nan_string, 1)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, number_constructor, "isNaN"), mal_value_new_undefined(), &nan_string, 1)));
    assert(mal_value_to_boolean(test_builtin_call(&vm, vm.intrinsics[MAL_INTRINSIC_IS_FINITE], mal_value_new_undefined(), &forty_two_string, 1)));

    assert(mal_value_to_f64(test_builtin_get(&vm, number_constructor, "MAX_SAFE_INTEGER")) == 9007199254740991.0);

    MalValue two_digits = mal_value_from_i32(2);
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, number_prototype, "toFixed"), three_point_five, &two_digits, 1), "3.50"));
    MalValue bad_digits = mal_value_from_i32(200);
    test_builtin_call_throws(&vm, test_builtin_get(&vm, number_prototype, "toFixed"), three, &bad_digits, 1, "RangeError");

    MalValue boolean_constructor = vm.intrinsics[MAL_INTRINSIC_BOOLEAN_CONSTRUCTOR];
    MalValue boolean_prototype = vm.intrinsics[MAL_INTRINSIC_BOOLEAN_PROTOTYPE];
    MalValue zero = mal_value_from_i32(0);
    assert(mal_value_to_boolean(test_builtin_call(&vm, boolean_constructor, mal_value_new_undefined(), &three, 1)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, boolean_constructor, mal_value_new_undefined(), &zero, 1)));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, boolean_prototype, "toString"), mal_value_new_boolean(true), NULL, 0), "true"));

    mal_vm_free(&vm);
}

static void test_vm_primitive_dispatch_and_unary_ops(void) {
    static const c16 length_units[] = {'l', 'e', 'n', 'g', 't', 'h'};
    static const c16 abc_units[] = {'a', 'b', 'c'};
    static const c16 upper_units[] = {'t', 'o', 'U', 'p', 'p', 'e', 'r', 'C', 'a', 's', 'e'};
    static const MalStringConstant string_constants[] = {
        {.length = 6, .code_units = length_units},
        {.length = 3, .code_units = abc_units},
        {.length = 11, .code_units = upper_units},
    };
    static const i32 no_arguments[] = {0};
    static const MalInstruction entry_instructions[] = {
        // "abc".length
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 0, .string_index = 1}},
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 1, .string_index = 0}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 2, .object = 0, .key = 1}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 2, .index = 0}},
        // "abc"[1]
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 1, .value = 1}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 2, .object = 0, .key = 1}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 2, .index = 1}},
        // "abc".toUpperCase() through the prototype dispatch
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 1, .string_index = 2}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 2, .object = 0, .key = 1}},
        {.opcode = MAL_OP_CALL, .as.call = {.dst = 3, .callee = 2, .this_value = 0, .argument_count = 0, .arguments = NULL}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 3, .index = 2}},
        // Unary operators
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 0, .value = 7}},
        {.opcode = MAL_OP_UNARY, .as.unary = {.dst = 1, .src = 0, .op = MAL_UNARY_NEGATE}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 1, .index = 3}},
        {.opcode = MAL_OP_UNARY, .as.unary = {.dst = 1, .src = 0, .op = MAL_UNARY_NOT}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 1, .index = 4}},
        {.opcode = MAL_OP_UNARY, .as.unary = {.dst = 1, .src = 0, .op = MAL_UNARY_BIT_NOT}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 1, .index = 5}},
        {.opcode = MAL_OP_UNARY, .as.unary = {.dst = 1, .src = 0, .op = MAL_UNARY_TYPEOF}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 1, .index = 6}},
        // Property loads on undefined throw a TypeError; catch it.
        {.opcode = MAL_OP_TRY_BEGIN},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 1, .string_index = 0}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 2, .object = 0, .key = 1}},
        {.opcode = MAL_OP_TRY_END},
        {.opcode = MAL_OP_JUMP, .as.jump = {.target_ip = 27}},
        {.opcode = MAL_OP_CATCH, .as.caught = {.dst = 3}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 3, .index = 7}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalExceptionHandler handlers[] = {
        {.start_ip = 20, .end_ip = 24, .handler_ip = 26},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 4, .captured_count = 0, .instruction_count = 30,
            .instructions = entry_instructions, .handler_count = 1, .handlers = handlers
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 1, .functions = functions, .string_constant_count = 3, .string_constants = string_constants, .global_count = 8
    };
    (void) no_arguments;

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(vm.completion.kind == MAL_COMPLETION_NORMAL);
    assert(mal_value_to_i32(vm.globals[0]) == 3);
    assert(test_builtin_value_is_ascii(&vm, vm.globals[1], "b"));
    assert(test_builtin_value_is_ascii(&vm, vm.globals[2], "ABC"));
    assert(mal_value_to_i32(vm.globals[3]) == -7);
    assert(!mal_value_to_boolean(vm.globals[4]));
    assert(mal_value_to_i32(vm.globals[5]) == -8);
    assert(test_builtin_value_is_ascii(&vm, vm.globals[6], "number"));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_get(&vm, vm.globals[7], "name"), "TypeError"));

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_builtin_math_json_console_and_global_this(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    MalValue math = vm.intrinsics[MAL_INTRINSIC_MATH];
    MalValue minus_five = mal_value_from_i32(-5);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, math, "abs"), math, &minus_five, 1)) == 5);

    MalValue max_args[] = {mal_value_from_i32(1), mal_value_from_i32(7), mal_value_from_i32(3)};
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, math, "max"), math, max_args, 3)) == 7);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, math, "min"), math, max_args, 3)) == 1);

    MalValue pow_args[] = {mal_value_from_i32(2), mal_value_from_i32(8)};
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, math, "pow"), math, pow_args, 2)) == 256);

    MalValue half = mal_value_from_f64(2.5);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, math, "round"), math, &half, 1)) == 3);

    f64 pi = mal_value_to_f64(test_builtin_get(&vm, math, "PI"));
    assert(pi > 3.14 && pi < 3.15);

    MalValue random = test_builtin_call(&vm, test_builtin_get(&vm, math, "random"), math, NULL, 0);
    f64 random_value = mal_value_is_f64(random) ? mal_value_to_f64(random) : (f64) mal_value_to_i32(random);
    assert(random_value >= 0 && random_value < 1);

    // JSON round trip.
    MalValue json = vm.intrinsics[MAL_INTRINSIC_JSON];
    MalObject *payload = mal_intrinsic_new_object(&vm);
    mal_intrinsic_define_data(&vm, payload, "a", mal_value_from_i32(1), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    MalArrayObject *list = mal_intrinsic_new_array(&vm, 2);
    mal_object_set((MalObject *) list, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)}, mal_value_new_boolean(true));
    mal_object_set((MalObject *) list, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(1)}, mal_value_new_null());
    mal_intrinsic_define_data(&vm, payload, "b", mal_value_from_array_object(list), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);

    MalValue payload_value = mal_value_from_object(payload);
    MalValue stringified = test_builtin_call(&vm, test_builtin_get(&vm, json, "stringify"), json, &payload_value, 1);
    assert(test_builtin_value_is_ascii(&vm, stringified, "{\"a\":1,\"b\":[true,null]}"));

    MalValue parsed = test_builtin_call(&vm, test_builtin_get(&vm, json, "parse"), json, &stringified, 1);
    assert(mal_value_to_i32(test_builtin_get(&vm, parsed, "a")) == 1);
    assert(mal_array_object_length(mal_value_to_array_object(test_builtin_get(&vm, parsed, "b"))) == 2);
    assert(mal_value_is_null(test_builtin_index(test_builtin_get(&vm, parsed, "b"), 1)));

    MalValue escaped = test_builtin_ascii(&vm, "line\nbreak \"quoted\"");
    MalValue escaped_json = test_builtin_call(&vm, test_builtin_get(&vm, json, "stringify"), json, &escaped, 1);
    assert(test_builtin_value_is_ascii(&vm, escaped_json, "\"line\\nbreak \\\"quoted\\\"\""));

    MalValue bad_json = test_builtin_ascii(&vm, "{\"a\":");
    test_builtin_call_throws(&vm, test_builtin_get(&vm, json, "parse"), json, &bad_json, 1, "SyntaxError");

    // globalThis wires the intrinsics together.
    MalValue global_this = vm.intrinsics[MAL_INTRINSIC_GLOBAL_THIS];
    assert(test_builtin_get(&vm, global_this, "Math") == math);
    assert(test_builtin_get(&vm, global_this, "globalThis") == global_this);
    assert(mal_value_is_nan(test_builtin_get(&vm, global_this, "NaN")));

    // console.log returns undefined and must not crash.
    MalValue log_args[] = {test_builtin_ascii(&vm, "console test:"), mal_value_from_i32(42), payload_value};
    assert(mal_value_is_undefined(test_builtin_call(&vm, test_builtin_get(&vm, vm.intrinsics[MAL_INTRINSIC_CONSOLE], "log"), vm.intrinsics[MAL_INTRINSIC_CONSOLE], log_args, 3)));

    mal_vm_free(&vm);
}

int main(void) {
    test_binary_value_ops_handle_int32_arithmetic();
    test_binary_value_ops_handle_bitwise_operations();
    test_string_values_use_utf16_code_unit_length();
    test_string_value_ops_concatenate_and_convert_values();
    test_string_value_ops_compare_strings_and_converted_numbers();
    test_vm_binary_op_dispatches_all_binary_operators();
    test_vm_call_frame_returns_to_caller();
    test_vm_call_frame_fills_missing_parameters_with_undefined();
    test_vm_create_string_uses_utf16_string_constants();
    test_vm_object_property_ops_create_read_and_write_properties();
    test_vm_array_property_ops_manage_indices_and_length();
    test_object_new_initializes_base_state();
    test_string_new_copy_owns_byte_storage();
    test_string_new_external_borrows_code_unit_storage();
    test_symbol_new_stores_optional_description();
    test_table_uses_structural_string_keys_and_identity_symbol_keys();
    test_property_define_lookup_and_entry_accessors();
    test_property_set_value_creates_default_data_descriptor();
    test_property_iter_storage_order_yields_insertion_order();
    test_property_iter_own_property_order_groups_index_string_and_symbol_keys();
    test_property_iter_enumerable_own_property_order_skips_non_enumerable_entries();
    test_object_ops_manage_extensibility_and_prototype_state();
    test_object_define_own_rejects_new_properties_on_non_extensible_objects();
    test_object_define_own_rejects_incompatible_non_configurable_changes();
    test_object_delete_own_respects_configurable_flag();
    test_object_resolve_property_walks_prototype_chain();
    test_object_set_updates_writable_own_properties_and_creates_new_properties();
    test_object_set_rejects_non_writable_data_properties();
    test_function_object_new_initializes_script_function_state();
    test_native_function_object_new_initializes_native_function_state();
    test_array_object_new_initializes_array_state();
    test_builtin_object_statics_and_prototype_methods();
    test_builtin_array_constructor_and_prototype_methods();
    test_builtin_error_constructors_and_to_string();
    test_vm_throw_error_sets_completion_and_builtins_throw();
    test_vm_try_catch_unwinds_to_handler();
    test_vm_nested_try_picks_innermost_handler_and_rethrows();
    test_vm_throw_unwinds_across_call_frames();
    test_vm_uncaught_throw_propagates_through_call_value();
    test_vm_construct_script_and_native_callees();
    test_bound_function_resolution_and_calls();
    test_builtin_function_call_apply_bind_and_to_string();
    test_vm_function_name_and_length_fast_path();
    test_builtin_string_constructor_and_prototype_methods();
    test_builtin_number_boolean_and_global_functions();
    test_vm_primitive_dispatch_and_unary_ops();
    test_builtin_math_json_console_and_global_this();

    MalVm vm;

    mal_vm_init(&vm, &mal_vm_definition);
    auto callable = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, callable);
    // tmp2.js checks its own result and throws on a mismatch.
    assert(vm.completion.kind == MAL_COMPLETION_NORMAL);
    mal_vm_free_callable(callable);
    mal_vm_free(&vm);

    printf("\n");

    return 0;
}
